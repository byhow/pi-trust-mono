import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(root, "packages");
const expectedPackages = [
  "@byhow/pi-model-picker",
  "pi-sisyphus",
  "pi-warm-memory",
];
const manifests = [];

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const manifest = JSON.parse(
      await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"),
    );
    manifests.push({ directory: entry.name, manifest });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const packageNames = manifests.map(({ manifest }) => manifest.name).sort();
if (JSON.stringify(packageNames) !== JSON.stringify(expectedPackages)) {
  throw new Error(
    `registration matrix expected ${expectedPackages.join(", ")}; found ${packageNames.join(", ")}`,
  );
}

const globalCommands = new Set();
const globalTools = new Set();
for (const { directory, manifest } of manifests) {
  const commands = manifest.hostConformance?.commands ?? [];
  const tools = manifest.hostConformance?.tools ?? [];
  for (const [kind, values, global] of [
    ["command", commands, globalCommands],
    ["tool", tools, globalTools],
  ]) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(
        `${manifest.name}: manifest has no ${kind} registrations`,
      );
    }
    for (const value of values) {
      if (
        typeof value !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/u.test(value) ||
        global.has(value)
      ) {
        throw new Error(
          `${manifest.name}: invalid or duplicate ${kind} ${value}`,
        );
      }
      global.add(value);
    }
  }

  const registered = { commands: [], tools: [], events: [] };
  const api = {
    on(event) {
      registered.events.push(event);
    },
    registerCommand(name) {
      registered.commands.push(name);
    },
    registerTool(tool) {
      registered.tools.push(tool.name);
    },
    sendUserMessage() {},
    async exec() {
      return { code: 0, killed: false, stdout: "", stderr: "" };
    },
  };

  for (const extension of manifest.pi?.extensions ?? []) {
    const extensionPath = resolve(packagesRoot, directory, extension);
    const loaded = await import(pathToFileURL(extensionPath).href);
    if (typeof loaded.default !== "function") {
      throw new Error(`${manifest.name}: ${extension} has no default factory`);
    }
    await loaded.default(api);
  }

  for (const key of ["commands", "tools", "events"]) {
    const actual = [...new Set(registered[key])].sort();
    const expected = [...new Set(manifest.hostConformance?.[key] ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${manifest.name}: ${key} manifest ${expected.join(", ")} != registration ${actual.join(", ")}`,
      );
    }
  }
}

console.log(
  `verify-registration-matrix: ${packageNames.join(", ")} registered ${globalCommands.size} commands and ${globalTools.size} tools`,
);
