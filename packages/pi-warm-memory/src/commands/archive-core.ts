/**
 * pi-warm-memory — the archive half of the warm layer, as pure logic.
 *
 * `/archive-session` builds a prompt that tells the model to write a handoff (or
 * checkpoint) packet plus a one-line index entry, so the next session can pick
 * up exactly where this one left off. The prompt assembly lives here — pure and
 * deterministic, with no pi-runtime dependency — so every branch is unit
 * testable. `archive-session.ts` is the thin adapter that gathers the inputs
 * (session id, git context, template, index state) and feeds them in.
 *
 * The command is a prompt-builder, not a summarizer: the model that lived the
 * session summarizes it.
 */
import { relative, resolve } from "node:path";
import type { GitContext } from "../git-context.ts";

/** The append-only index header, written once as line 1 of index.jsonl. */
export const INDEX_HEADER = '{"version":1,"kind":"thread-index","entries":[]}';

export type PacketKind = "handoff" | "checkpoint";

/** Template filename for each packet kind. */
export const TEMPLATE_FILE: Record<PacketKind, string> = {
  handoff: "handoff-packet.md",
  checkpoint: "checkpoint-packet.md",
};

/** Split raw args into a packet kind and the free-text instruction. */
export const parseArchiveArgs = (
  args: readonly string[],
): { packetKind: PacketKind; instruction: string } => {
  const packetKind: PacketKind =
    args[0] === "checkpoint" ? "checkpoint" : "handoff";
  const instruction = (packetKind === "checkpoint" ? args.slice(1) : args)
    .join(" ")
    .trim();
  return { packetKind, instruction };
};

/** Inputs gathered by the adapter — everything the prompt depends on. */
export type ArchivePromptInput = {
  packetKind: PacketKind;
  instruction: string;
  sessionId: string;
  cwd: string;
  historyDir: string;
  /** ISO timestamp; injected (not `new Date()` inside) so output is deterministic per input. */
  timestamp: string;
  git: GitContext;
  template: string;
  /** True when index.jsonl is missing or lacks the thread-index header (fresh project). */
  needsHeader: boolean;
};

/**
 * Build the archive prompt. Pure: identical input ⇒ identical output, no I/O,
 * no clock. Owns all path and formatting logic so it is the single test surface
 * for the archive command's behaviour.
 */
export const buildArchivePrompt = (input: ArchivePromptInput): string => {
  const {
    packetKind,
    instruction,
    sessionId,
    cwd,
    historyDir,
    timestamp,
    git,
    template,
    needsHeader,
  } = input;

  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(5, 7);

  // CWD-relative paths for the LLM to write to
  const packetDirRel = relative(
    cwd,
    resolve(historyDir, "packets", year, month),
  );
  const indexRel = relative(cwd, resolve(historyDir, "index.jsonl"));

  // Path stored in index entries is relative to the history root (portable across machines)
  const indexEntryPathPrefix = `packets/${year}/${month}/`;

  // Git summary block
  const gitBlock = [
    `- Repo: ${git.repoName}`,
    git.branch ? `- Branch: ${git.branch}` : undefined,
    git.shortSha ? `- Commit: ${git.shortSha}` : undefined,
    `- CWD: ${cwd}`,
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
    cwd,
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
};
