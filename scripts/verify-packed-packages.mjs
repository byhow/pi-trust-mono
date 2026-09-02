import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const forbidden =
  /(?:^|\/)(?:node_modules|coverage|\.git|\.DS_Store)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const portablePath = (path) => path.split(sep).join("/");

const enumerateAllowlistedFiles = async (packageRoot, manifestFiles) => {
  const files = [];
  const visit = async (path) => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `${portablePath(relative(packageRoot, path))}: packed allowlist entries must not be symbolic links`,
      );
    }
    if (metadata.isFile()) {
      files.push(portablePath(relative(packageRoot, path)));
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `${portablePath(relative(packageRoot, path))}: packed allowlist entry is not a regular file or directory`,
      );
    }
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) await visit(join(path, entry.name));
  };

  for (const entry of manifestFiles) await visit(join(packageRoot, entry));
  return files.sort();
};

const dryRunPack = async (packageName) => {
  const cache = await mkdtemp(join(tmpdir(), "pi-trust-npm-cache-"));
  try {
    const { stdout } = await execute(
      "npm",
      ["pack", "--json", "--dry-run", "--workspace", packageName],
      {
        cwd: root,
        env: {
          ...process.env,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_CACHE: cache,
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          NPM_CONFIG_USERCONFIG: "/dev/null",
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const result = JSON.parse(stdout)[0];
    if (!result) throw new Error(`${packageName}: npm pack returned no result`);
    return result;
  } finally {
    await rm(cache, { force: true, recursive: true });
  }
};

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (manifest.private === true) continue;

  const packageRoot = join(packagesRoot, entry.name);
  const [firstPack, secondPack] = await Promise.all([
    dryRunPack(manifest.name),
    dryRunPack(manifest.name),
  ]);
  const packSignature = (pack) =>
    JSON.stringify({
      version: pack.version,
      size: pack.size,
      unpackedSize: pack.unpackedSize,
      shasum: pack.shasum,
      integrity: pack.integrity,
      files: pack.files,
    });
  if (packSignature(firstPack) !== packSignature(secondPack)) {
    throw new Error(
      `${manifest.name}: repeated npm pack output is not deterministic`,
    );
  }

  const files = firstPack.files?.map((file) => file.path).sort() ?? [];
  if (!files.includes("package.json")) {
    throw new Error(`${manifest.name}: packed payload lacks package.json`);
  }
  if (files.some((path) => forbidden.test(path))) {
    throw new Error(
      `${manifest.name}: packed payload contains test/cache material`,
    );
  }
  for (const extension of manifest.pi?.extensions ?? []) {
    const normalized = extension.replace(/^\.\//u, "");
    if (!files.includes(normalized)) {
      throw new Error(`${manifest.name}: packed payload lacks ${normalized}`);
    }
  }

  const expectedFiles = [
    "package.json",
    ...(await enumerateAllowlistedFiles(packageRoot, manifest.files ?? [])),
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    const expected = new Set(expectedFiles);
    const actual = new Set(files);
    const missing = expectedFiles.filter((file) => !actual.has(file));
    const unexpected = files.filter((file) => !expected.has(file));
    throw new Error(
      `${manifest.name}: packed payload differs from files allowlist; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

console.log("verify-packed-packages: ok");
