import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CustomCommand,
  CustomCommandAPI,
  CustomCommandFactory,
  HookCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { gatherGitContext } from "../git-context.ts";
import { resolveHistoryDir } from "../paths.ts";
import {
  buildArchivePrompt,
  parseArchiveArgs,
  TEMPLATE_FILE,
} from "./archive-core.ts";

/**
 * `/archive-session` — thin adapter over the pure prompt assembly in
 * archive-core.ts. All prompt/path/format logic lives there (and is unit
 * tested); this file only gathers runtime inputs (session id, git context,
 * template, index state) and feeds them to `buildArchivePrompt`.
 */

/** Resolve the package root from this module's own location (src/commands/ → ../../). */
const getPackageRoot = async (): Promise<string> => {
  const moduleFile = await realpath(fileURLToPath(import.meta.url));
  return resolve(dirname(moduleFile), "../..");
};

/**
 * Extract the session UUID from an OMP session file path.
 * OMP session files are named <timestamp>_<uuid>.jsonl.
 */
const getSessionId = (ctx: HookCommandContext): string => {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) {
    throw new Error("/archive-session requires a persisted OMP session.");
  }

  const filename = basename(sessionFile, extname(sessionFile));
  const sessionId = filename.includes("_")
    ? (filename.split("_").at(-1) ?? filename)
    : filename;
  if (!/^[0-9a-f-]+$/i.test(sessionId)) {
    throw new Error(`Could not derive a valid session ID from ${sessionFile}.`);
  }

  return sessionId;
};

/** True if index.jsonl is missing or lacks the thread-index header line. */
const indexNeedsHeader = async (historyDir: string): Promise<boolean> => {
  try {
    const existing = await readFile(resolve(historyDir, "index.jsonl"), "utf8");
    return !existing.includes('"kind":"thread-index"');
  } catch {
    return true;
  }
};

const createCommand = (api: CustomCommandAPI): CustomCommand => ({
  name: "archive-session",
  description:
    "Archive the current session as a handoff or checkpoint packet. " +
    "Usage: /archive-session [checkpoint] <instruction>",
  async execute(args, ctx) {
    const { packetKind, instruction } = parseArchiveArgs(args);
    const sessionId = getSessionId(ctx);

    const packageRoot = await getPackageRoot();
    const historyDir = resolveHistoryDir(ctx.cwd);
    const template = await readFile(
      resolve(packageRoot, "templates", TEMPLATE_FILE[packetKind]),
      "utf8",
    );

    // Git context and the index-header check are independent reads — gather in parallel.
    const [git, needsHeader] = await Promise.all([
      gatherGitContext((cmd, a, opts) => api.exec(cmd, a, opts), ctx.cwd),
      indexNeedsHeader(historyDir),
    ]);

    return buildArchivePrompt({
      packetKind,
      instruction,
      sessionId,
      cwd: ctx.cwd,
      historyDir,
      timestamp: new Date().toISOString(),
      git,
      template,
      needsHeader,
    });
  },
});

const archiveSessionFactory: CustomCommandFactory = (api) => createCommand(api);

export default archiveSessionFactory satisfies CustomCommandFactory;
