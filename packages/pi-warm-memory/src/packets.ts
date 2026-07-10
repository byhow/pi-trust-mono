/**
 * Map the warm-memory `index.jsonl` into search documents.
 *
 * `index.jsonl` is the durable source of truth: line 1 is a `thread-index` header,
 * every other line is a `packet-ref` written by /archive-session. We index the
 * structured refs (topic/summary/tags/files) — not the packet bodies — so recall
 * is cheap: one file read, no packet I/O. The `filePath` we surface is the packet
 * path the agent then reads on demand.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusDocument } from "./search/corpus.ts";

/** Shape of a `packet-ref` line, as written by archive-session.ts. */
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

const asStringArray = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Parse `<historyDir>/index.jsonl` into corpus documents. Returns [] if the index
 * does not exist yet (fresh project). Malformed lines and the header are skipped.
 */
export const buildPacketDocs = async (
  historyDir: string,
): Promise<readonly CorpusDocument[]> => {
  let raw: string;
  try {
    raw = await readFile(join(historyDir, "index.jsonl"), "utf8");
  } catch {
    return [];
  }

  const docs: CorpusDocument[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: PacketRef;
    try {
      entry = JSON.parse(trimmed) as PacketRef;
    } catch {
      continue; // skip malformed lines rather than fail the whole recall
    }
    if (entry.kind !== "packet-ref" || !entry.path) continue;

    const tags = asStringArray(entry.tags);
    const files = asStringArray(entry.files);
    const topic = entry.topic ?? "";
    const summary = entry.summary ?? "";

    docs.push({
      title: topic || summary || entry.path,
      // BM25 corpus: fold every searchable signal into content so a query on a
      // filename, tag, or topic all hit.
      content: [topic, summary, tags.join(" "), files.join(" ")]
        .filter(Boolean)
        .join("\n"),
      date: entry.timestamp ?? "",
      tags,
      source: entry.packetKind ?? "handoff",
      filePath: entry.path, // the packet the agent reads to reconstruct context
      excerpt: summary,
    });
  }

  return docs;
};
