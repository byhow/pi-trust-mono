import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const forbidden =
  /(?:^|\/)(?:node_modules|coverage|\.git|\.DS_Store)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u;

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(
    await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"),
  );
  if (manifest.private === true) continue;

  const { stdout } = await execute(
    "npm",
    ["pack", "--json", "--dry-run", "--workspace", manifest.name],
    {
      cwd: root,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  const files = result[0]?.files?.map((file) => file.path) ?? [];
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
}

console.log("verify-packed-packages: ok");
