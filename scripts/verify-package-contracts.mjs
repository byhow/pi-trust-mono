import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const expectedPeers = {
  "@earendil-works/pi-coding-agent": "0.84.2",
  "@oh-my-pi/pi-coding-agent": "17.4.1 || 18.0.3",
};
const failures = [];
const fail = (packageName, message) =>
  failures.push(`${packageName}: ${message}`);

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoot = join(packagesRoot, entry.name);
  const manifestPath = join(packageRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    fail(entry.name, "package.json is invalid");
    continue;
  }

  const packageName = manifest.name || entry.name;
  if (manifest.private === true)
    fail(packageName, "publishable packages must not be private");
  if (manifest.type !== "module")
    fail(packageName, 'package type must be "module"');
  if (manifest.license !== "MIT" && manifest.license !== "Apache-2.0") {
    fail(packageName, "license must be declared as MIT or Apache-2.0");
  }
  if (
    !manifest.repository?.directory ||
    manifest.repository.directory !== `packages/${entry.name}`
  ) {
    fail(packageName, "repository.directory must match the workspace path");
  }
  if (!manifest.exports?.["."]) fail(packageName, "root export is required");
  if (!manifest.scripts?.test || !manifest.scripts?.["test:coverage"]) {
    fail(packageName, "test and test:coverage scripts are required");
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0)
    fail(packageName, "an explicit files allowlist is required");
  if (
    files.some((path) => path === "src" || /(?:^|\/)\.\.(?:\/|$)/u.test(path))
  ) {
    fail(
      packageName,
      "files must enumerate source modules without broad or parent paths",
    );
  }
  if (
    files.some((path) =>
      /(?:\.test\.|\.spec\.|coverage|node_modules|\.DS_Store)/u.test(path),
    )
  ) {
    fail(packageName, "files allowlist contains test or cache material");
  }

  for (const file of files) {
    try {
      await access(join(packageRoot, file));
    } catch {
      fail(packageName, `allowlisted file does not exist: ${file}`);
    }
  }

  const piExtensions = manifest.pi?.extensions;
  const ompExtensions = manifest.omp?.extensions;
  const isExtension =
    Array.isArray(piExtensions) || Array.isArray(ompExtensions);
  if (isExtension) {
    if (JSON.stringify(piExtensions) !== JSON.stringify(ompExtensions)) {
      fail(packageName, "pi.extensions and omp.extensions must be identical");
    }
    const commands = manifest.hostConformance?.commands;
    if (
      !Array.isArray(commands) ||
      commands.length === 0 ||
      new Set(commands).size !== commands.length ||
      commands.some(
        (command) =>
          typeof command !== "string" ||
          !/^[a-z][a-z0-9-]{0,63}$/u.test(command),
      )
    ) {
      fail(
        packageName,
        "hostConformance.commands must list unique bounded command names",
      );
    }
    const tools = manifest.hostConformance?.tools;
    if (
      !Array.isArray(tools) ||
      tools.length === 0 ||
      new Set(tools).size !== tools.length ||
      tools.some(
        (tool) =>
          typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(tool),
      )
    ) {
      fail(
        packageName,
        "hostConformance.tools must list unique bounded tool names",
      );
    }
    const events = manifest.hostConformance?.events ?? [];
    if (
      !Array.isArray(events) ||
      new Set(events).size !== events.length ||
      events.some((event) => event !== "tool_call")
    ) {
      fail(packageName, "hostConformance.events contains an unsupported event");
    }
    for (const [peer, version] of Object.entries(expectedPeers)) {
      if (manifest.peerDependencies?.[peer] !== version) {
        fail(
          packageName,
          `${peer} must declare the tested version contract ${version}`,
        );
      }
      if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) {
        fail(packageName, `${peer} must remain an optional peer`);
      }
    }
    for (const extension of piExtensions ?? []) {
      const normalized = extension.replace(/^\.\//u, "");
      if (!files.includes(normalized)) {
        fail(
          packageName,
          `extension entry is not shipped explicitly: ${extension}`,
        );
      }
    }
  }

  for (const file of files.filter((path) => path.endsWith(".ts"))) {
    const source = await readFile(join(packageRoot, file), "utf8");
    if (/from\s+["']@oh-my-pi\//u.test(source)) {
      fail(packageName, `${file} imports an OMP-only runtime module`);
    }
    if (/from\s+["']@earendil-works\/pi-coding-agent\//u.test(source)) {
      fail(packageName, `${file} imports a host-private Pi subpath`);
    }
    if (/\b(?:TODO|FIXME|stubbed|placeholder)\b/iu.test(source)) {
      fail(packageName, `${file} contains unfinished implementation markers`);
    }
  }

  const workspacePath = relative(root, packageRoot).split(sep).join("/");
  if (manifest.repository?.directory !== workspacePath) {
    fail(
      packageName,
      "repository.directory is not portable from repository root",
    );
  }
}

if (failures.length > 0) {
  throw new Error(
    `Package contract verification failed:\n- ${failures.join("\n- ")}`,
  );
}
console.log("verify-package-contracts: ok");
