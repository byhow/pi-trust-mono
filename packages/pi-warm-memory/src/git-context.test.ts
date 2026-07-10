import { describe, expect, test } from "vitest";
import {
  type GitExec,
  gatherGitContext,
  parseStatusLines,
} from "./git-context.ts";

/* ---------------------------------------------------------------------------
 * parseStatusLines — pure git-status parser
 * ------------------------------------------------------------------------- */
describe("parseStatusLines", () => {
  test("drops the 2-char status code + space prefix from each line", () => {
    expect(parseStatusLines(" M src/foo.ts\n?? bar.ts\nA  baz.ts")).toEqual([
      "src/foo.ts",
      "bar.ts",
      "baz.ts",
    ]);
  });

  test("returns [] for empty input", () => {
    expect(parseStatusLines("")).toEqual([]);
  });

  test("trims trailing whitespace and filters blank lines", () => {
    expect(parseStatusLines(" M a.ts   \n\n M b.ts\n   ")).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  test("preserves the rename arrow shape (unchanged from prior behaviour)", () => {
    expect(parseStatusLines("R  old.ts -> new.ts")).toEqual([
      "old.ts -> new.ts",
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * gatherGitContext — adapter over an injected exec
 * ------------------------------------------------------------------------- */
type Stub =
  | string
  | { code: number; killed?: boolean; stdout?: string }
  | Error;

const exec = (table: Record<string, Stub>): GitExec => {
  return async (cmd, args) => {
    const v = table[`${cmd} ${args.join(" ")}`];
    if (v === undefined) return { code: 0, killed: false, stdout: "" };
    if (v instanceof Error) throw v;
    if (typeof v === "string") return { code: 0, killed: false, stdout: v };
    return { code: v.code, killed: v.killed ?? false, stdout: v.stdout ?? "" };
  };
};

const TOPLEVEL = "git rev-parse --show-toplevel";
const BRANCH = "git rev-parse --abbrev-ref HEAD";
const SHORT = "git rev-parse --short HEAD";
const STATUS = "git status --short --untracked-files=all";
const cwd = "/projects/demo";

describe("gatherGitContext", () => {
  test("surfaces repo, branch, sha and parsed files when inside a git repo", async () => {
    const git = await gatherGitContext(
      exec({
        [TOPLEVEL]: "/home/u/pi-trust-mono",
        [BRANCH]: "main",
        [SHORT]: "abc1234",
        [STATUS]: " M src/a.ts\n?? new.ts",
      }),
      cwd,
    );
    expect(git).toEqual({
      repoName: "pi-trust-mono",
      repoRoot: "/home/u/pi-trust-mono",
      branch: "main",
      shortSha: "abc1234",
      filesTouched: ["src/a.ts", "new.ts"],
    });
  });

  test("falls back to the cwd basename and omits branch/sha/files outside a repo", async () => {
    const git = await gatherGitContext(
      exec({ [TOPLEVEL]: { code: 128 } }),
      cwd,
    );
    expect(git).toEqual({
      repoName: "demo",
      repoRoot: undefined,
      branch: undefined,
      shortSha: undefined,
      filesTouched: [],
    });
  });

  test("treats a thrown exec the same as a failed command (never throws)", async () => {
    const git = await gatherGitContext(
      exec({ [TOPLEVEL]: new Error("git not found") }),
      cwd,
    );
    expect(git.repoName).toBe("demo");
    expect(git.branch).toBeUndefined();
  });

  test("treats an empty branch stdout as no branch but still gathers sha/files", async () => {
    const git = await gatherGitContext(
      exec({
        [TOPLEVEL]: "/r/app",
        [BRANCH]: "",
        [SHORT]: "deadbee",
        [STATUS]: " M x.ts",
      }),
      cwd,
    );
    expect(git.branch).toBeUndefined();
    expect(git.shortSha).toBe("deadbee");
    expect(git.filesTouched).toEqual(["x.ts"]);
  });

  test("yields no files when the status output is empty", async () => {
    const git = await gatherGitContext(
      exec({
        [TOPLEVEL]: "/r/app",
        [STATUS]: "",
      }),
      cwd,
    );
    expect(git.filesTouched).toEqual([]);
  });
});
