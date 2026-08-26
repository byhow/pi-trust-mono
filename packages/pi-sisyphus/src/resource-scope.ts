import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ResourceScope =
  | "workspace"
  | "external"
  | "unknown"
  | "not-applicable";

const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Find",
  "Ls",
]);
const DEFAULT_WORKSPACE_TOOLS = new Set(["Grep", "Glob", "Find", "Ls"]);
const PATH_KEYS = ["path", "filePath", "file"] as const;

const nearestExistingPath = async (
  path: string,
): Promise<string | undefined> => {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
};

const isWithin = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child);
  return (
    fromParent === "" ||
    (!fromParent.startsWith("..") && !isAbsolute(fromParent))
  );
};

/** Classify only path metadata; file contents are never read. */
export const classifyResourceScope = async (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<ResourceScope> => {
  if (!FILE_TOOLS.has(toolName)) return "not-applicable";
  const rawPath = PATH_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (rawPath === undefined) {
    return DEFAULT_WORKSPACE_TOOLS.has(toolName) ? "workspace" : "unknown";
  }

  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(resolve(cwd));
  } catch {
    return "unknown";
  }
  const canonicalTarget = await nearestExistingPath(
    resolve(canonicalCwd, rawPath),
  );
  if (!canonicalTarget) return "unknown";
  return isWithin(canonicalCwd, canonicalTarget) ? "workspace" : "external";
};
