import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HistoryLocation } from "./paths.ts";
import type { CorpusDocument } from "./search/corpus.ts";
import { hasControlCharacter } from "./text-safety.ts";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_LINES = 4_097;
const MAX_PACKET_BYTES = 32 * 1024;
const PACKET_PATH = /^packets\/\d{4}\/\d{2}\/[a-z0-9._-]+\.md$/iu;

type PacketRef = {
  readonly packetKind: "handoff" | "checkpoint";
  readonly timestamp: string;
  readonly path: string;
  readonly topic: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly files: readonly string[];
};

export type PacketIndexStatus = "ready" | "missing" | "unreadable" | "corrupt";

export type PacketDocsResult = {
  readonly status: PacketIndexStatus;
  readonly docs: readonly CorpusDocument[];
};

export type PacketBody = {
  readonly locator: string;
  readonly content: string;
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const isWithin = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !pathFromParent.startsWith("..") &&
    !isAbsolute(pathFromParent)
  );
};

const assertRegularPacket = async (handle: FileHandle): Promise<number> => {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_PACKET_BYTES ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("unsafe packet file");
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
  if (offset !== size) throw new Error("packet changed while reading");
  return buffer.subarray(0, size).toString("utf8");
};

const safePacketPath = async (
  historyRoot: string,
  packetPath: string,
): Promise<string | undefined> => {
  if (!PACKET_PATH.test(packetPath) || isAbsolute(packetPath)) return undefined;

  const packetsRoot = resolve(historyRoot, "packets");
  const candidate = resolve(historyRoot, packetPath);
  if (!isWithin(packetsRoot, candidate)) return undefined;

  try {
    if ((await realpath(packetsRoot)) !== packetsRoot) return undefined;
    const candidateParent = dirname(candidate);
    if ((await realpath(candidateParent)) !== candidateParent) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
};

const inspectPacket = async (
  historyRoot: string,
  packetPath: string,
): Promise<boolean> => {
  const candidate = await safePacketPath(historyRoot, packetPath);
  if (!candidate) return false;
  try {
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertRegularPacket(handle);
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const readPacket = async (
  historyRoot: string,
  packetPath: string,
): Promise<string | undefined> => {
  const candidate = await safePacketPath(historyRoot, packetPath);
  if (!candidate) return undefined;
  try {
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await readExact(handle, await assertRegularPacket(handle));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

const boundedString = (
  value: unknown,
  maxLength: number,
  fallback = "",
): string | undefined => {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    return undefined;
  }
  return value;
};

const stringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const parsed = boundedString(item, maxLength);
    if (parsed === undefined) return undefined;
    result.push(parsed);
  }
  return result;
};

const parsePacketRef = (value: unknown): PacketRef | null | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!("kind" in value) || value.kind !== "packet-ref") return null;
  if (!("version" in value) || value.version !== 1) return undefined;

  const packetKind = "packetKind" in value ? value.packetKind : undefined;
  const path = "path" in value ? boundedString(value.path, 1_024) : undefined;
  const timestamp =
    "timestamp" in value ? boundedString(value.timestamp, 64) : "";
  const topic = "topic" in value ? boundedString(value.topic, 160) : "";
  const summary = "summary" in value ? boundedString(value.summary, 800) : "";
  const tags = "tags" in value ? stringArray(value.tags, 24, 64) : [];
  const files = "files" in value ? stringArray(value.files, 128, 500) : [];

  if (
    (packetKind !== "handoff" && packetKind !== "checkpoint") ||
    !path ||
    !PACKET_PATH.test(path) ||
    timestamp === undefined ||
    topic === undefined ||
    summary === undefined ||
    tags === undefined ||
    files === undefined ||
    files.some((file) => isAbsolute(file) || file.split("/").includes(".."))
  ) {
    return undefined;
  }

  return { packetKind, path, timestamp, topic, summary, tags, files };
};

const resolveHistoryRoot = async (
  location: HistoryLocation,
): Promise<
  | { readonly status: "ready"; readonly root: string }
  | { readonly status: "missing" | "unreadable" }
> => {
  if (!location.projectScoped) {
    try {
      const metadata = await lstat(location.path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return { status: "unreadable" };
      }
      return { status: "ready", root: await realpath(location.path) };
    } catch (error) {
      return {
        status: errorCode(error) === "ENOENT" ? "missing" : "unreadable",
      };
    }
  }

  try {
    const canonicalProject = await realpath(location.projectRoot);
    const pathFromProject = relative(location.projectRoot, location.path);
    if (
      pathFromProject === "" ||
      pathFromProject.startsWith("..") ||
      isAbsolute(pathFromProject)
    ) {
      return { status: "unreadable" };
    }
    let current = canonicalProject;
    for (const segment of pathFromProject.split(sep)) {
      current = join(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return { status: "unreadable" };
      }
    }
    return { status: "ready", root: current };
  } catch (error) {
    return {
      status: errorCode(error) === "ENOENT" ? "missing" : "unreadable",
    };
  }
};

const readIndex = async (
  location: HistoryLocation,
): Promise<
  | { readonly status: Exclude<PacketIndexStatus, "ready"> }
  | {
      readonly status: "ready";
      readonly historyRoot: string;
      readonly refs: readonly PacketRef[];
    }
> => {
  const root = await resolveHistoryRoot(location);
  if (root.status !== "ready") return { status: root.status };
  const historyRoot = root.root;

  let raw: string;
  try {
    const handle = await open(
      join(historyRoot, "index.jsonl"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size > MAX_INDEX_BYTES ||
        (metadata.mode & 0o022) !== 0
      ) {
        return { status: "unreadable" };
      }
      raw = await readExact(handle, metadata.size);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { status: errorCode(error) === "ENOENT" ? "missing" : "unreadable" };
  }

  const lines = raw.split(/\r?\n/);
  if (lines.length > MAX_INDEX_LINES) return { status: "corrupt" };
  try {
    const header = JSON.parse(lines[0] ?? "") as {
      kind?: unknown;
      version?: unknown;
    };
    if (header.kind !== "thread-index" || header.version !== 1) {
      return { status: "corrupt" };
    }
  } catch {
    return { status: "corrupt" };
  }

  const refs: PacketRef[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    try {
      const parsed = parsePacketRef(JSON.parse(line));
      if (parsed === undefined) return { status: "corrupt" };
      if (parsed) refs.push(parsed);
    } catch {
      return { status: "corrupt" };
    }
  }
  return { status: "ready", historyRoot, refs };
};

/** Map validated index-v1 records to bounded search documents. */
export const buildPacketDocs = async (
  location: HistoryLocation,
): Promise<PacketDocsResult> => {
  const index = await readIndex(location);
  if (index.status !== "ready") return { status: index.status, docs: [] };

  const docs: CorpusDocument[] = [];
  for (const entry of index.refs) {
    if (!(await inspectPacket(index.historyRoot, entry.path))) continue;
    docs.push({
      title: entry.topic || entry.summary || entry.path,
      content: [
        entry.topic,
        entry.summary,
        entry.tags.join(" "),
        entry.files.join(" "),
      ]
        .filter(Boolean)
        .join("\n"),
      date: entry.timestamp,
      tags: entry.tags,
      source: entry.packetKind,
      filePath: entry.path,
      excerpt: entry.summary,
    });
  }
  return { status: "ready", docs };
};

/** Read only already-ranked packet bodies through the same confinement checks. */
export const readPacketBodies = async (
  location: HistoryLocation,
  locators: readonly string[],
): Promise<readonly PacketBody[]> => {
  const root = await resolveHistoryRoot(location);
  if (root.status !== "ready") return [];
  const historyRoot = root.root;

  const bodies: PacketBody[] = [];
  for (const locator of locators.slice(0, 3)) {
    const content = await readPacket(historyRoot, locator);
    if (content !== undefined) bodies.push({ locator, content });
  }
  return bodies;
};
