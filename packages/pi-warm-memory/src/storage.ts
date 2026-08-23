import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { INDEX_HEADER, type ArchiveDraft } from "./commands/archive-core.ts";
import { allowsGitTracking, type HistoryLocation } from "./paths.ts";

export type WriteArchiveResult =
  | { readonly status: "success"; readonly locator: string }
  | { readonly status: "escaped" }
  | { readonly status: "index-missing" }
  | { readonly status: "index-corrupt" }
  | { readonly status: "index-locked" };

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const writeJsonlAppend = async (
  path: string,
  entry: string,
): Promise<boolean> => {
  try {
    const fd = await readFile(path, "utf8");
    if (!fd.startsWith(INDEX_HEADER.slice(0, 30))) return false;
  } catch {
    return false;
  }
  try {
    await writeFile(path, `\n${entry}`, { flag: "a", encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
};

const renderPacketMarkdown = (
  timestamp: string,
  draft: ArchiveDraft,
): string => {
  const parts = [
    `# ${draft.packetKind === "handoff" ? "Handoff" : "Checkpoint"} Packet`,
  ];
  parts.push(
    `- Timestamp: ${timestamp}\n- Topic: ${draft.topic}\n- Tags: ${draft.tags.join(" ") || "none"}`,
  );
  if (draft.goal) parts.push(`- Goal: ${draft.goal}`);
  if (draft.risk) parts.push(`- Risk: ${draft.risk}`);
  parts.push(`- Next Step: ${draft.nextStep}`);
  parts.push(`## Summary\n${draft.summary}`);
  if (draft.files.length) {
    parts.push(`## Files\n${draft.files.map((f) => `- ${f}`).join("\n")}`);
  }
  if (draft.decisions.length) {
    parts.push(
      `## Decisions\n${draft.decisions.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  if (draft.commands.length) {
    parts.push(
      `## Commands\n${draft.commands.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (draft.blockers.length) {
    parts.push(
      `## Blockers\n${draft.blockers.map((b) => `- ${b}`).join("\n")}`,
    );
  }
  if (draft.openQuestions.length) {
    parts.push(
      `## Open Questions\n${draft.openQuestions.map((q) => `- ${q}`).join("\n")}`,
    );
  }
  if (draft.changes.length) {
    parts.push(`## Changes\n${draft.changes.map((c) => `- ${c}`).join("\n")}`);
  }
  if (draft.pendingDecisions.length) {
    parts.push(
      `## Pending Decisions\n${draft.pendingDecisions.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  return parts.join("\n\n") + "\n";
};

/**
 * Safely create the packet file and append it to the index.
 * The destination must remain under the canonical history root; symlinks
 * that escape the root cause the operation to fail closed.
 */
export const persistArchive = async (
  location: HistoryLocation,
  sessionId: string,
  timestamp: string,
  repoName: string,
  gitTracking: string | undefined,
  draft: ArchiveDraft,
): Promise<WriteArchiveResult> => {
  let root: string;
  try {
    root = await realpath(location.path);
  } catch {
    root = location.path;
  }
  if (
    location.projectScoped &&
    relative(location.projectRoot, root).startsWith("..")
  ) {
    return { status: "escaped" };
  }

  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(5, 7);
  const safeTimestamp = timestamp.replace(/:/g, "-");
  const slug = slugify(draft.topic) || "session";
  const filename = `${safeTimestamp}-${draft.packetKind}-${slug}.md`;

  const packetDir = join(root, "packets", year, month);
  const packetPath = join(packetDir, filename);
  const indexPath = join(root, "index.jsonl");

  try {
    await mkdir(packetDir, { recursive: true });
    const resolvedPacketDir = await realpath(packetDir);
    if (!resolvedPacketDir.startsWith(root)) return { status: "escaped" };
  } catch {
    return { status: "escaped" };
  }

  if (location.projectScoped && !allowsGitTracking(gitTracking)) {
    try {
      await stat(join(root, ".gitignore"));
    } catch {
      await writeFile(join(root, ".gitignore"), "*\n!.gitignore\n", "utf8");
    }
  }

  let hasIndex = false;
  try {
    await stat(indexPath);
    hasIndex = true;
  } catch {
    await writeFile(indexPath, INDEX_HEADER, "utf8");
    hasIndex = true;
  }

  const packetRel = `packets/${year}/${month}/${filename}`;
  const entry = JSON.stringify({
    version: 1,
    kind: "packet-ref",
    packetKind: draft.packetKind,
    threadId: sessionId,
    timestamp,
    repo: repoName,
    path: packetRel,
    topic: draft.topic,
    tags: draft.tags,
    files: draft.files,
    summary: draft.summary,
  });

  if (hasIndex) {
    const appended = await writeJsonlAppend(indexPath, entry);
    if (!appended) return { status: "index-corrupt" };
  }

  await writeFile(packetPath, renderPacketMarkdown(timestamp, draft), "utf8");

  return { status: "success", locator: packetRel };
};
