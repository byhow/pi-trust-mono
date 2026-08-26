import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.PI_MATRIX_HOST;
const hostBinary = process.env.PI_MATRIX_BIN;

if ((host !== "omp" && host !== "pi") || !hostBinary) {
  throw new Error("PI_MATRIX_HOST=omp|pi and PI_MATRIX_BIN are required");
}

const stateRoot = await mkdtemp(join(tmpdir(), `pi-trust-${host}-`));
const packRoot = join(stateRoot, "packs");
const unpackRoot = join(stateRoot, "unpacked");
const home = join(stateRoot, "home");
const work = join(stateRoot, "work");
const temporary = join(stateRoot, "tmp");
await Promise.all(
  [packRoot, unpackRoot, home, work, temporary].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);

const extensionPackages = [];
const expectedCommands = new Set();
for (const entry of await readdir(join(root, "packages"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(
        join(root, "packages", entry.name, "package.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (!Array.isArray(manifest.pi?.extensions)) continue;
  extensionPackages.push(manifest.name);
  for (const command of manifest.hostConformance?.commands ?? []) {
    expectedCommands.add(command);
  }
}
extensionPackages.sort();

const packagePaths = [];
for (const packageName of extensionPackages) {
  const { stdout } = await execute(
    "npm",
    [
      "pack",
      "--json",
      "--workspace",
      packageName,
      "--pack-destination",
      packRoot,
    ],
    {
      cwd: root,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const packed = JSON.parse(stdout)[0];
  if (!packed?.filename) {
    throw new Error(`${packageName}: npm pack returned no file`);
  }
  const destination = join(unpackRoot, packageName);
  await mkdir(destination, { recursive: true });
  await execute("tar", [
    "-xzf",
    join(packRoot, packed.filename),
    "-C",
    destination,
  ]);
  const packagePath = join(destination, "package");
  await execute(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--registry=https://registry.npmjs.org",
    ],
    {
      cwd: packagePath,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  packagePaths.push(packagePath);
}

const isolatedEnvironment = {
  HOME: home,
  PATH: process.env.PATH ?? "",
  TMPDIR: temporary,
  NO_COLOR: "1",
  PI_OFFLINE: "1",
  GEMINI_API_KEY: "fixture",
  OMP_PROFILE: "sf",
  PI_WARM_HISTORY_DIR: join(stateRoot, "history"),
};

if (host === "omp") {
  for (const packagePath of packagePaths) {
    await execute(hostBinary, ["plugin", "link", packagePath, "--json"], {
      cwd: work,
      env: isolatedEnvironment,
    });
  }
  const modelsPath = join(home, ".omp", "profiles", "sf", "agent");
  await mkdir(modelsPath, { recursive: true });
  await writeFile(
    join(modelsPath, "models.yml"),
    `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:4789/v1\n    auth: none\n    authHeader: false\n    models:\n      - id: fixture\n        name: Fixture\n        api: openai-completions\n        reasoning: false\n        input: [text]\n        supportsTools: true\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 32000\n        maxTokens: 4096\n`,
    "utf8",
  );
} else {
  for (const packagePath of packagePaths) {
    await execute(hostBinary, ["install", packagePath, "--approve"], {
      cwd: work,
      env: isolatedEnvironment,
    });
  }
}

const commandType = host === "omp" ? "get_available_commands" : "get_commands";
const hostArgs =
  host === "omp"
    ? ["--mode", "rpc", "--model", "fixture/fixture"]
    : ["--mode", "rpc", "--approve"];

const queryCommands = () => {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers();
  const child = spawn(hostBinary, hostArgs, {
    cwd: work,
    env: isolatedEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`${host}: RPC command query timed out`));
  }, 20_000);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const frame = JSON.parse(line);
        if (frame.id === "matrix" && frame.type === "response") {
          clearTimeout(timeout);
          child.kill("SIGTERM");
          resolveResult(frame.data?.commands ?? []);
        }
      } catch {
        // Host startup banners are not RPC frames.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0 && code !== null && code !== 143) {
      clearTimeout(timeout);
      reject(new Error(`${host}: RPC host exited before command response`));
    }
  });
  setTimeout(() => {
    child.stdin.write(
      `${JSON.stringify({ id: "matrix", type: commandType })}\n`,
    );
  }, 500);
  return promise;
};

const commands = await queryCommands();
const registered = new Set(commands.map((command) => command.name));
for (const expected of expectedCommands) {
  if (!registered.has(expected)) {
    throw new Error(`${host}: command not registered: ${expected}`);
  }
}
console.log(
  `verify-behavioral-host-matrix: ${host} loaded ${extensionPackages.join(", ")} and registered ${[...expectedCommands].sort().join(", ")}`,
);
