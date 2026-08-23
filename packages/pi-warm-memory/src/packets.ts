import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CorpusDocument } from "./search/corpus.ts";

/** Shape of a `packet-ref` line, as written by /archive-session. */
type PacketRef = {
  readonly kind?: string;
  readonly packetKind?: string;
  readonly timestamp?: string;
  readonly path?: string;
  readonly topic?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly files?: readonly string[];
};

type ThreadIndexHeader = {
  readonly kind?: string;
  readonly version?: number;
};

export type PacketIndexStatus = "ready" | "missing" | "unreadable" | "corrupt";

export type PacketDocsResult = {
  readonly status: PacketIndexStatus;
  readonly docs: readonly CorpusDocument[];
};

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const isWithin = (parent: string, child: string): boolean => {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !pathFromParent.startsWith("..") &&
    !isAbsolute(pathFromParent)
  );
};

const isIndexHeader = (value: unknown): value is ThreadIndexHeader =>
  typeof value === "object" &&
  value !== null &&
  (value as ThreadIndexHeader).kind === "thread-index" &&
  (value as ThreadIndexHeader).version === 1;

const readPacketLocator = async (
  historyRoot: string,
  packetsRoot: string,
  packetPath: string,
): Promise<string | undefined> => {
  if (!packetPath || packetPath.includes("\0") || isAbsolute(packetPath))
    return undefined;

  const candidate = resolve(historyRoot, packetPath);
  if (!isWithin(packetsRoot, candidate)) return undefined;

  try {
    const resolvedPacket = await realpath(candidate);
    return isWithin(packetsRoot, resolvedPacket) ? resolvedPacket : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Map the durable index-v1 JSONL into search documents.
 *
 * The returned locator is an existing, real path below the actual
 * `<historyRoot>/packets` directory. Index entries are untrusted and are never
 * used as read paths until they pass lexical and realpath confinement.
 */
export const buildPacketDocs = async (
  historyDir: string,
): Promise<PacketDocsResult> => {
  let raw: string;
  try {
    raw = await readFile(join(historyDir, "index.jsonl"), "utf8");
  } catch (error) {
    return {
      status:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
          ? "missing"
          : "unreadable",
      docs: [],
    };
  }

  const lines = raw.split(/\r?\n/);
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return { status: "corrupt", docs: [] };
  }
  if (!isIndexHeader(header)) return { status: "corrupt", docs: [] };

  let historyRoot: string;
  try {
    historyRoot = await realpath(historyDir);
  } catch {
    return { status: "unreadable", docs: [] };
  }
  const packetsRoot = resolve(historyRoot, "packets");

  const docs: CorpusDocument[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const trimmed = lines[lineIndex]?.trim();
    if (!trimmed) continue;

    let entry: PacketRef;
    try {
      entry = JSON.parse(trimmed) as PacketRef;
    } catch {
      return { status: "corrupt", docs: [] };
    }
    if (entry.kind !== "packet-ref" || typeof entry.path !== "string") continue;

    const filePath = await readPacketLocator(
      historyRoot,
      packetsRoot,
      entry.path,
    );
    if (!filePath) continue;

    const tags = asStringArray(entry.tags);
    const files = asStringArray(entry.files);
    const topic = entry.topic ?? "";
    const summary = entry.summary ?? "";

    docs.push({
      title: topic || summary || entry.path,
      content: [topic, summary, tags.join(" "), files.join(" ")]
        .filter(Boolean)
        .join("\n"),
      date: entry.timestamp ?? "",
      tags,
      source: entry.packetKind ?? "handoff",
      filePath,
      excerpt: summary,
    });
  }

  return { status: "ready", docs };
};
