/**
 * Git context gathering for /archive-session.
 *
 * `gatherGitContext` is an adapter over an injected `exec` function — the pi
 * exec API in production, a fake in tests — so the git seam has two adapters and
 * is real, not hypothetical. `parseStatusLines` is the pure half (the status
 * parser), lifted out so it is unit-testable without git. This module has no
 * dependency on the pi runtime.
 */
import { basename } from "node:path";

/** Minimal structural port over the pi exec result — keeps this module pi-free. */
export type GitExecResult = { code: number; killed: boolean; stdout: string };

/**
 * Execute a command. A structural subset of the pi exec API: callers pass
 * `api.exec` (production) or a fake (tests).
 */
export type GitExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<GitExecResult>;

/** Repo context surfaced into the archive prompt's Session Context block. */
export type GitContext = {
  repoName: string;
  repoRoot?: string;
  branch?: string;
  shortSha?: string;
  filesTouched: string[];
};

/**
 * Parse `git status --short --untracked-files=all` output into a path list.
 * Each line is `<XY> <path>` — two status columns plus one space (3 chars) — so
 * the prefix is sliced off and the remainder trimmed.
 */
export const parseStatusLines = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

/**
 * Run one command, returning stdout with trailing whitespace stripped on success.
 * Uses trimEnd (not trim): a leading space on the first `git status` line is a
 * real status-code column, and trimming it would corrupt the first file path.
 * Never throws.
 */
const run = async (
  exec: GitExec,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | undefined> => {
  try {
    const r = await exec(cmd, args, { cwd });
    return r.code === 0 && !r.killed
      ? r.stdout.trimEnd() || undefined
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Gather git context via the injected exec. Best-effort: a missing repo or a
 * failing command degrades gracefully (no branch/sha, repoName from cwd).
 */
export const gatherGitContext = async (
  exec: GitExec,
  cwd: string,
): Promise<GitContext> => {
  const repoRoot = await run(
    exec,
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  const repoName = repoRoot ? basename(repoRoot) : basename(cwd);
  const branch = repoRoot
    ? await run(exec, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    : undefined;
  const shortSha = repoRoot
    ? await run(exec, "git", ["rev-parse", "--short", "HEAD"], cwd)
    : undefined;

  let filesTouched: string[] = [];
  if (repoRoot) {
    const status = await run(
      exec,
      "git",
      ["status", "--short", "--untracked-files=all"],
      cwd,
    );
    if (status) filesTouched = parseStatusLines(status);
  }

  return { repoName, repoRoot, branch, shortSha, filesTouched };
};
