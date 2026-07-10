import { readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CustomCommand,
  CustomCommandAPI,
  CustomCommandFactory,
  HookCommandContext,
} from "@oh-my-pi/pi-coding-agent";

/**
 * pi-warm-memory — cross-session episodic memory for pi agents.
 *
 * `/archive-session` reviews the current session and writes a structured handoff
 * (or checkpoint) packet plus a one-line index entry, so the next session can
 * pick up exactly where this one left off. The command is a prompt-builder, not
 * a summarizer: the model that lived the session summarizes it.
 */

/** Default history location, relative to the project root. */
const DEFAULT_HISTORY_DIR = ".pi/history";

/** Env override for the history directory (see package.json → pi.settings.historyDir.env). */
const HISTORY_DIR_ENV = "PI_WARM_HISTORY_DIR";

/** The append-only index header, written once as line 1 of index.jsonl. */
const INDEX_HEADER = '{"version":1,"kind":"thread-index","entries":[]}';

/**
 * Resolve the history directory: an absolute or cwd-relative value from the env
 * override, otherwise the project-local default. Reads `process.env` directly so
 * it stays in sync with the manifest `settings.historyDir.env` fallback.
 */
const resolveHistoryDir = (cwd: string): string => {
  const configured = process.env[HISTORY_DIR_ENV];
  if (configured)
    return isAbsolute(configured) ? configured : resolve(cwd, configured);
  return resolve(cwd, DEFAULT_HISTORY_DIR);
};

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

/** Collect git context via the pi exec API. */
const getGitContext = async (api: CustomCommandAPI, cwd: string) => {
  const run = async (cmd: string, args: string[]) => {
    try {
      const r = await api.exec(cmd, args, { cwd });
      return r.code === 0 && !r.killed
        ? r.stdout.trim() || undefined
        : undefined;
    } catch {
      return undefined;
    }
  };

  const repoRoot = await run("git", ["rev-parse", "--show-toplevel"]);
  const repoName = repoRoot ? basename(repoRoot) : basename(cwd);
  const branch = repoRoot
    ? await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])
    : undefined;
  const shortSha = repoRoot
    ? await run("git", ["rev-parse", "--short", "HEAD"])
    : undefined;

  let filesTouched: string[] = [];
  if (repoRoot) {
    const status = await run("git", [
      "status",
      "--short",
      "--untracked-files=all",
    ]);
    if (status) {
      filesTouched = status
        .split(/\r?\n/)
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    }
  }

  return { repoName, repoRoot, branch, shortSha, filesTouched };
};

const createCommand = (api: CustomCommandAPI): CustomCommand => ({
  name: "archive-session",
  description:
    "Archive the current session as a handoff or checkpoint packet. " +
    "Usage: /archive-session [checkpoint] <instruction>",
  async execute(args, ctx) {
    const packetKind = args[0] === "checkpoint" ? "checkpoint" : "handoff";
    const instruction = (packetKind === "checkpoint" ? args.slice(1) : args)
      .join(" ")
      .trim();

    const sessionId = getSessionId(ctx);
    const packageRoot = await getPackageRoot();
    const historyDir = resolveHistoryDir(ctx.cwd);

    const templatesDir = resolve(packageRoot, "templates");
    const templateFile =
      packetKind === "handoff" ? "handoff-packet.md" : "checkpoint-packet.md";
    const template = await readFile(
      resolve(templatesDir, templateFile),
      "utf8",
    );

    const git = await getGitContext(api, ctx.cwd);
    const timestamp = new Date().toISOString();
    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(5, 7);

    // CWD-relative paths for the LLM to write to
    const packetDirRel = relative(
      ctx.cwd,
      resolve(historyDir, "packets", year, month),
    );
    const indexRel = relative(ctx.cwd, resolve(historyDir, "index.jsonl"));

    // Path stored in index entries is relative to the history root (portable across machines)
    const indexEntryPathPrefix = `packets/${year}/${month}/`;

    // Lazily ensure the index header exists. On a fresh project there is no
    // index.jsonl yet; the first packet must seed its header line.
    let needsHeader = false;
    try {
      const existing = await readFile(
        resolve(historyDir, "index.jsonl"),
        "utf8",
      );
      if (!existing.includes('"kind":"thread-index"')) needsHeader = true;
    } catch {
      needsHeader = true;
    }

    // Git summary block
    const gitBlock = [
      `- Repo: ${git.repoName}`,
      git.branch ? `- Branch: ${git.branch}` : undefined,
      git.shortSha ? `- Commit: ${git.shortSha}` : undefined,
      `- CWD: ${ctx.cwd}`,
      git.filesTouched.length > 0
        ? `- Files touched:\n${git.filesTouched.map((f) => `  - ${f}`).join("\n")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    // Example index entry (with placeholder values for the LLM to fill)
    const indexEntryExample = JSON.stringify({
      version: 1,
      kind: "packet-ref",
      packetKind,
      threadId: sessionId,
      timestamp,
      repo: "<repo name>",
      cwd: ctx.cwd,
      path: `${indexEntryPathPrefix}<timestamp>-<kind>-<slug>.md`,
      topic: "<topic>",
      tags: ["<tag1>"],
      files: ["<file1>"],
      summary: "<one-line summary>",
    });

    const indexStep = needsHeader
      ? `Create \`${indexRel}\` if it does not exist. Its **line 1** must be the index header, exactly:
   \`\`\`json
   ${INDEX_HEADER}
   \`\`\`
   Then append your packet-ref line below it. Do NOT modify or remove the header.`
      : `Append **one JSON line** to \`${indexRel}\`. Do NOT modify or remove existing lines.`;

    return `Archive this session as a **${packetKind}** packet.

## User Instruction
${instruction || "Summarize the work done in this session and create a comprehensive handoff packet."}

## Packet Template
Fill in every field of this template based on the conversation history:

${template.trim()}

## Session Context
- Thread ID: ${sessionId}
- Timestamp: ${timestamp}
${gitBlock}

## Instructions

1. Review the conversation history of this session thoroughly.
2. Fill in every field of the template above. Derive accurate values from the conversation — do not make things up.
3. Write the filled packet as a markdown file in \`${packetDirRel}/\`:
   - Filename: \`${timestamp.replace(/:/g, "-")}-${packetKind}-<slugified-topic>.md\`
4. ${indexStep}
   The appended line must follow this shape (replace angle-bracket values):
   \`\`\`json
   ${indexEntryExample}
   \`\`\`
   The \`path\` value must start with \`${indexEntryPathPrefix}\` and use the same filename as the packet you wrote.
5. Report what you wrote.

Be thorough but concise. Use the actual conversation to derive values — the summary should be useful for someone picking up where this session left off.`;
  },
});

const archiveSessionFactory: CustomCommandFactory = (api) => {
  return createCommand(api);
};

export default archiveSessionFactory satisfies CustomCommandFactory;
