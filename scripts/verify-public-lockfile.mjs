import { readFile } from "node:fs/promises";

const lockPath = new URL("../package-lock.json", import.meta.url);
const raw = await readFile(lockPath, "utf8");

if (
  /(?:_authToken|always-auth|npmjs-internal|repo\.local|nexus|sfdc\.net)/i.test(
    raw,
  )
) {
  throw new Error(
    "package-lock.json contains a private registry or authentication marker",
  );
}

const lock = JSON.parse(raw);
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.resolved !== "string"
  ) {
    continue;
  }

  let resolved;
  try {
    resolved = new URL(metadata.resolved);
  } catch {
    continue;
  }

  if (
    resolved.protocol !== "https:" ||
    resolved.hostname !== "registry.npmjs.org" ||
    resolved.username ||
    resolved.password
  ) {
    throw new Error(
      `package-lock.json has a non-public resolved dependency at ${packagePath || "<root>"}`,
    );
  }
  if (typeof metadata.integrity !== "string" || !metadata.integrity) {
    // Upstream pi-coding-agent uses a shrinkwrap that causes npm to omit integrity fields for its transitive dependencies.
    if (
      packagePath?.includes(
        "node_modules/@earendil-works/pi-coding-agent/node_modules/",
      )
    ) {
      continue;
    }
    throw new Error(
      `package-lock.json is missing integrity hash for fetched dependency at ${packagePath || "<root>"}`,
    );
  }
}

console.log("verify-public-lockfile: ok");
