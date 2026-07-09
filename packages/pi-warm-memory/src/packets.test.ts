import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildPacketDocs } from "./packets.ts";

const header = '{"version":1,"kind":"thread-index","entries":[]}';
const ref = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    kind: "packet-ref",
    packetKind: "handoff",
    threadId: "abc",
    timestamp: "2026-04-17T10:00:00.000Z",
    path: "packets/2026/04/2026-04-17-handoff-auth.md",
    topic: "auth token refactor",
    tags: ["auth", "backend"],
    files: ["src/session-validator.ts"],
    summary: "Split the session validator; next: rotate signing keys.",
    ...over,
  });

const writeIndex = async (lines: readonly string[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warm-"));
  await writeFile(join(dir, "index.jsonl"), lines.join("\n"), "utf8");
  return dir;
};

describe("buildPacketDocs", () => {
  test("returns [] when index.jsonl is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-warm-empty-"));
    expect(await buildPacketDocs(dir)).toEqual([]);
  });

  test("skips the header and maps packet-refs to docs", async () => {
    const dir = await writeIndex([header, ref()]);
    const docs = await buildPacketDocs(dir);
    expect(docs.length).toBe(1);
    const [doc] = docs;
    expect(doc).toBeDefined();
    if (!doc) return;
    expect(doc.title).toBe("auth token refactor");
    expect(doc.source).toBe("handoff");
    expect(doc.filePath).toBe("packets/2026/04/2026-04-17-handoff-auth.md");
    expect(doc.tags).toEqual(["auth", "backend"]);
    expect(doc.excerpt).toBe(
      "Split the session validator; next: rotate signing keys.",
    );
    // topic + summary + tags + files are folded into content so a query on
    // any of them hits.
    expect(doc.content).toContain("session-validator");
    expect(doc.content).toContain("backend");
  });

  test("maps every packet-ref line, in order", async () => {
    const dir = await writeIndex([
      header,
      ref({ path: "packets/a.md", topic: "first" }),
      ref({ path: "packets/b.md", topic: "second" }),
      ref({ path: "packets/c.md", topic: "third" }),
    ]);
    const docs = await buildPacketDocs(dir);
    expect(docs.map((d) => d.title)).toEqual(["first", "second", "third"]);
  });

  test("preserves the packet kind as the doc source", async () => {
    const dir = await writeIndex([
      header,
      ref({ packetKind: "checkpoint", path: "packets/cp.md" }),
    ]);
    const [doc] = await buildPacketDocs(dir);
    expect(doc?.source).toBe("checkpoint");
  });

  test("defaults source to 'handoff' when packetKind is absent", async () => {
    const dir = await writeIndex([
      header,
      ref({ packetKind: undefined, path: "packets/nokind.md" }),
    ]);
    const [doc] = await buildPacketDocs(dir);
    expect(doc?.source).toBe("handoff");
  });

  test("tolerates malformed lines without failing the batch", async () => {
    const dir = await writeIndex([
      header,
      "{not json",
      ref({ path: "packets/b.md" }),
    ]);
    const docs = await buildPacketDocs(dir);
    expect(docs.length).toBe(1);
    expect(docs[0]?.filePath).toBe("packets/b.md");
  });

  test("ignores blank lines", async () => {
    const dir = await writeIndex([
      header,
      "",
      ref({ path: "packets/x.md" }),
      "",
    ]);
    const docs = await buildPacketDocs(dir);
    expect(docs.length).toBe(1);
  });

  test("ignores refs with no path", async () => {
    const dir = await writeIndex([header, ref({ path: undefined })]);
    expect(await buildPacketDocs(dir)).toEqual([]);
  });

  test("skips non-packet-ref entries other than the header", async () => {
    const dir = await writeIndex([
      header,
      '{"kind":"note","text":"ignore me"}',
      ref({ path: "packets/keep.md" }),
    ]);
    const docs = await buildPacketDocs(dir);
    expect(docs.length).toBe(1);
    expect(docs[0]?.filePath).toBe("packets/keep.md");
  });

  test("coerces non-array tags/files to empty arrays", async () => {
    const dir = await writeIndex([
      header,
      ref({ path: "packets/badtags.md", tags: "not-an-array", files: null }),
    ]);
    const [doc] = await buildPacketDocs(dir);
    expect(doc?.tags).toEqual([]);
  });

  test("drops non-string entries inside tags", async () => {
    const dir = await writeIndex([
      header,
      ref({ path: "packets/mixed.md", tags: ["ok", 42, null, "fine"] }),
    ]);
    const [doc] = await buildPacketDocs(dir);
    expect(doc?.tags).toEqual(["ok", "fine"]);
  });

  test("falls back to summary then path for the title", async () => {
    const dir = await writeIndex([
      header,
      ref({ topic: "", summary: "just a summary" }),
    ]);
    expect((await buildPacketDocs(dir))[0]?.title).toBe("just a summary");
  });

  test("falls back to the path when topic and summary are both empty", async () => {
    const dir = await writeIndex([
      header,
      ref({ topic: "", summary: "", path: "packets/only-path.md" }),
    ]);
    expect((await buildPacketDocs(dir))[0]?.title).toBe("packets/only-path.md");
  });

  test("tolerates a missing timestamp (empty date)", async () => {
    const dir = await writeIndex([
      header,
      ref({ timestamp: undefined, path: "packets/nodate.md" }),
    ]);
    expect((await buildPacketDocs(dir))[0]?.date).toBe("");
  });

  test("tolerates absent topic and summary (undefined, not just empty)", async () => {
    const dir = await writeIndex([
      header,
      ref({ topic: undefined, summary: undefined, path: "packets/bare.md" }),
    ]);
    const [doc] = await buildPacketDocs(dir);
    // title falls all the way back to the path; excerpt is empty.
    expect(doc?.title).toBe("packets/bare.md");
    expect(doc?.excerpt).toBe("");
  });
});
