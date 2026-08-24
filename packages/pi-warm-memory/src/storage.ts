import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { type ArchiveDraft, INDEX_HEADER } from "./commands/archive-core.ts";
import { allowsGitTracking, type HistoryLocation } from "./paths.ts";
import { hasControlCharacter } from "./text-safety.ts";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const PRIVATE_IGNORE = "*\n!.gitignore\n";

export type WriteArchiveResult =
  | { readonly status: "success"; readonly locator: string }
  | {
      readonly status:
        | "unsafe"
        | "index-corrupt"
        | "collision"
        | "write-failed";
    };

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

const list = (values: readonly string[]): string =>
  values.length > 0
    ? values.map((value) => `  - ${value}`).join("\n")
    : "  - None";

const renderPacketMarkdown = (
  sessionId: string,
  timestamp: string,
  repository: string,
  draft: ArchiveDraft,
): string => {
  if (draft.packetKind === "checkpoint") {
    return `# Checkpoint Packet

- Thread ID: ${sessionId}
- Timestamp: ${timestamp}
- Current Task: ${draft.topic}
- What Changed Since Last Checkpoint:
${list(draft.changes)}
- Files Touched:
${list(draft.files)}
- Current Risk: ${draft.risk || "None"}
- Pending Decisions:
${list(draft.pendingDecisions)}
- Immediate Next Step: ${draft.nextStep}
- Tags: ${draft.tags.join(", ") || "none"}
- Brief Summary: ${draft.summary}
`;
  }

  return `# Handoff Packet

- Thread ID: ${sessionId}
- Timestamp: ${timestamp}
- Repository: ${repository}
- Topic: ${draft.topic}
- Goal: ${draft.goal || draft.topic}
- Decisions Made:
${list(draft.decisions)}
- Files Touched:
${list(draft.files)}
- Commands Run:
${list(draft.commands)}
- Blockers:
${list(draft.blockers)}
- Open Questions:
${list(draft.openQuestions)}
- Next Recommended Step: ${draft.nextStep}
- Tags: ${draft.tags.join(", ") || "none"}
- Compact Summary: ${draft.summary}
`;
};

const ensureProjectScopedRoot = async (
  location: HistoryLocation,
): Promise<string> => {
  const canonicalProject = await realpath(location.projectRoot);
  const pathFromProject = relative(location.projectRoot, location.path);
  let current = canonicalProject;

  for (const segment of pathFromProject.split(sep)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("unsafe history directory");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("unsafe history directory");
      }
    }
  }

  return current;
};

const prepareHistoryRoot = async (
  location: HistoryLocation,
): Promise<string> => {
  if (location.projectScoped) return ensureProjectScopedRoot(location);

  await mkdir(location.path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(location.path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("unsafe history directory");
  }
  return realpath(location.path);
};

const ensureNestedDirectory = async (
  root: string,
  segments: readonly string[],
): Promise<string> => {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("unsafe archive directory");
    }
  }
  return current;
};

const assertRegularPrivateFile = async (
  handle: FileHandle,
  maxBytes: number,
): Promise<number> => {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > maxBytes ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe archive file");
  }
  return metadata.size;
};

const readExact = async (handle: FileHandle, size: number): Promise<string> => {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error("archive file changed while reading");
  return buffer.subarray(0, size).toString("utf8");
};

const validateIndex = (raw: string): boolean => {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== INDEX_HEADER) return false;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { kind?: unknown; version?: unknown };
      if (parsed.kind !== "packet-ref" || parsed.version !== 1) return false;
    } catch {
      return false;
    }
  }
  return true;
};

type OpenedIndex = {
  readonly handle: FileHandle;
  readonly endsWithNewline: boolean;
};

const openIndexForAppend = async (
  indexPath: string,
): Promise<OpenedIndex | undefined> => {
  try {
    const handle = await open(
      indexPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    try {
      const size = await assertRegularPrivateFile(handle, MAX_INDEX_BYTES);
      const raw = await readExact(handle, size);
      if (!validateIndex(raw)) throw new Error("corrupt archive index");
      return { handle, endsWithNewline: raw.endsWith("\n") };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
};

const ensurePrivateIgnore = async (root: string): Promise<void> => {
  const ignorePath = join(root, ".gitignore");
  try {
    const handle = await open(
      ignorePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(PRIVATE_IGNORE, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const handle = await open(
      ignorePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertRegularPrivateFile(handle, 4 * 1024);
    } finally {
      await handle.close();
    }
  }
};

const commitIndex = async (
  indexPath: string,
  openedIndex: OpenedIndex | undefined,
  entry: string,
): Promise<void> => {
  if (openedIndex) {
    try {
      const prefix = openedIndex.endsWithNewline ? "" : "\n";
      await openedIndex.handle.writeFile(`${prefix}${entry}\n`, "utf8");
      await openedIndex.handle.sync();
    } finally {
      await openedIndex.handle.close();
    }
    return;
  }

  try {
    const handle = await open(
      indexPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${INDEX_HEADER}\n${entry}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const concurrentIndex = await openIndexForAppend(indexPath);
    if (!concurrentIndex) throw new Error("archive index disappeared");
    await commitIndex(indexPath, concurrentIndex, entry);
  }
};

const safeMetadata = (value: string, maxLength: number): boolean =>
  value.length > 0 && value.length <= maxLength && !hasControlCharacter(value);

/** Atomically creates a packet before committing its single append-only index record. */
export const persistArchive = async (
  location: HistoryLocation,
  sessionId: string,
  timestamp: string,
  repository: string,
  gitTracking: string | undefined,
  draft: ArchiveDraft,
): Promise<WriteArchiveResult> => {
  if (
    !safeMetadata(sessionId, 256) ||
    !safeMetadata(timestamp, 64) ||
    !safeMetadata(repository, 256)
  ) {
    return { status: "unsafe" };
  }

  let root: string;
  let packetHandle: FileHandle | undefined;
  let packetPath = "";
  try {
    root = await prepareHistoryRoot(location);
    if (location.projectScoped && !allowsGitTracking(gitTracking)) {
      await ensurePrivateIgnore(root);
    }

    const year = timestamp.slice(0, 4);
    const month = timestamp.slice(5, 7);
    if (!/^\d{4}$/u.test(year) || !/^\d{2}$/u.test(month)) {
      return { status: "unsafe" };
    }

    const packetDir = await ensureNestedDirectory(root, [
      "packets",
      year,
      month,
    ]);
    const slug = slugify(draft.topic) || "session";
    const filename = `${timestamp.replace(/:/gu, "-")}-${draft.packetKind}-${slug}.md`;
    packetPath = join(packetDir, filename);
    const locator = `packets/${year}/${month}/${filename}`;
    const indexPath = join(root, "index.jsonl");
    const openedIndex = await openIndexForAppend(indexPath);

    try {
      packetHandle = await open(
        packetPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      await openedIndex?.handle.close();
      return {
        status: errorCode(error) === "EEXIST" ? "collision" : "write-failed",
      };
    }

    const packetMetadata = await packetHandle.stat();
    await packetHandle.writeFile(
      renderPacketMarkdown(sessionId, timestamp, repository, draft),
      "utf8",
    );
    await packetHandle.sync();

    const entry = JSON.stringify({
      version: 1,
      kind: "packet-ref",
      packetKind: draft.packetKind,
      threadId: sessionId,
      timestamp,
      repo: basename(repository),
      path: locator,
      topic: draft.topic,
      tags: draft.tags,
      files: draft.files,
      summary: draft.summary,
    });

    try {
      await commitIndex(indexPath, openedIndex, entry);
    } catch {
      await packetHandle.close();
      packetHandle = undefined;
      const currentMetadata = await lstat(packetPath);
      if (
        currentMetadata.dev === packetMetadata.dev &&
        currentMetadata.ino === packetMetadata.ino
      ) {
        await unlink(packetPath);
      }
      return { status: "index-corrupt" };
    }

    await packetHandle.close();
    packetHandle = undefined;
    return { status: "success", locator };
  } catch {
    await packetHandle?.close();
    return { status: "unsafe" };
  }
};
