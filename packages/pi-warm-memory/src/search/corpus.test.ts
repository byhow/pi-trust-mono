import { describe, expect, test } from "vitest";
import {
  type CorpusDocument,
  createIndex,
  EMBEDDING_DIMENSIONS,
  type EmbedFunction,
  getIndexCount,
  indexDocument,
  loadOrRebuild,
  searchCorpus,
} from "./corpus.ts";

const makeDoc = (overrides: Partial<CorpusDocument> = {}): CorpusDocument => ({
  title: "auth token refactor",
  content:
    "Refactored the auth token flow; decided to split the session validator.",
  date: "2026-04-17",
  tags: ["auth", "backend"],
  source: "handoff",
  filePath: "packets/2026/04/2026-04-17-handoff-auth.md",
  excerpt: "Split the session validator; next: rotate signing keys.",
  ...overrides,
});

const seed = async (docs: readonly CorpusDocument[]) => {
  const db = await createIndex();
  for (const d of docs) await indexDocument(db, d);
  return db;
};

describe("searchCorpus — BM25", () => {
  test("ranks a keyword match above an unrelated doc", async () => {
    const db = await seed([
      makeDoc(),
      makeDoc({
        title: "CSS grid layout fix",
        content: "Fixed the dashboard grid layout on narrow viewports.",
        tags: ["frontend", "css"],
        filePath: "packets/2026/04/layout.md",
      }),
    ]);

    const { hits } = await searchCorpus(db, "auth token");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.filePath).toContain("auth");
  });

  test("returns empty hits for a non-matching query (no throw)", async () => {
    const db = await seed([makeDoc()]);
    const { hits, count } = await searchCorpus(db, "kubernetes helm chart");
    expect(count).toBeGreaterThanOrEqual(0);
    expect(hits.length).toBe(0);
  });
});

describe("searchCorpus — filters", () => {
  test("--tags requires all listed tags (containsAll)", async () => {
    const db = await seed([
      makeDoc({ tags: ["auth", "backend"] }),
      makeDoc({ tags: ["auth"], filePath: "packets/only-auth.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", {
      tags: ["auth", "backend"],
    });
    // Exactly the two-tag doc matches; the auth-only doc is excluded.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe(
      "packets/2026/04/2026-04-17-handoff-auth.md",
    );
    expect(hits.every((h) => h.tags.includes("backend"))).toBe(true);
  });

  test("--kind maps to source eq filter", async () => {
    const db = await seed([
      makeDoc({ source: "handoff" }),
      makeDoc({ source: "checkpoint", filePath: "packets/cp.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", { source: "checkpoint" });
    // The handoff doc is excluded; only the checkpoint survives.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe("packets/cp.md");
    expect(hits.every((h) => h.source === "checkpoint")).toBe(true);
  });

  test("--since keeps only docs on/after the date, dropping older ones", async () => {
    const db = await seed([
      makeDoc({ date: "2026-01-01", filePath: "packets/old.md" }),
      makeDoc({ date: "2026-06-01", filePath: "packets/new.md" }),
    ]);
    const { hits, count } = await searchCorpus(db, "auth", {
      since: "2026-05-01",
    });
    // Regression guard: a real match must survive (an empty result would make
    // `every(...)` vacuously pass and hide a broken filter).
    expect(hits).toHaveLength(1);
    expect(count).toBe(1);
    expect(hits[0]?.filePath).toBe("packets/new.md");
    expect(hits.some((h) => h.filePath === "packets/old.md")).toBe(false);
  });

  test("--since is inclusive of the boundary date", async () => {
    const db = await seed([
      makeDoc({ date: "2026-05-01", filePath: "packets/onboundary.md" }),
      makeDoc({ date: "2026-04-30", filePath: "packets/before.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", { since: "2026-05-01" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe("packets/onboundary.md");
  });

  test("--since combines with a keyword query (only matching + recent)", async () => {
    const db = await seed([
      makeDoc({ date: "2026-06-01", filePath: "packets/recent-auth.md" }),
      makeDoc({
        date: "2026-06-02",
        filePath: "packets/recent-css.md",
        title: "CSS grid",
        content: "layout work",
        tags: ["frontend"],
      }),
      makeDoc({ date: "2026-01-01", filePath: "packets/old-auth.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", { since: "2026-05-01" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.filePath).toBe("packets/recent-auth.md");
  });
});

describe("searchCorpus — input guards", () => {
  test("throws on a query vector of the wrong dimensionality", async () => {
    const db = await seed([makeDoc()]);
    await expect(
      searchCorpus(db, "auth", { vector: [0.1, 0.2] }),
    ).rejects.toThrow(/dimensions, expected 384/);
  });

  test("throws on a malformed --since value", async () => {
    const db = await seed([makeDoc()]);
    await expect(
      searchCorpus(db, "auth", { since: "last tuesday" }),
    ).rejects.toThrow(/Invalid `since`/);
  });

  test("accepts a well-formed ISO --since value", async () => {
    const db = await seed([makeDoc({ date: "2026-06-01" })]);
    await expect(
      searchCorpus(db, "auth", { since: "2026-05-01" }),
    ).resolves.toBeDefined();
  });
});

describe("indexDocument — embed seam", () => {
  test("computes an embedding via the embed function when provided", async () => {
    const db = await createIndex();
    const embed: EmbedFunction = async (text) =>
      Array.from(
        { length: EMBEDDING_DIMENSIONS },
        (_, i) => ((text.length + i) % 7) / 7,
      );
    await indexDocument(db, makeDoc(), embed);
    expect(await getIndexCount(db)).toBe(1);

    const doc = makeDoc();
    const seededLength = doc.title.length + doc.content.length + 1;
    const vector = Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, i) => ((seededLength + i) % 7) / 7,
    );
    const { hits } = await searchCorpus(db, "auth", { vector }, 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("indexes the doc even when the embed function throws", async () => {
    const db = await createIndex();
    const embed: EmbedFunction = async () => {
      throw new Error("embedding service down");
    };
    // Should swallow the embed failure and still index (without a vector).
    await indexDocument(db, makeDoc(), embed);
    expect(await getIndexCount(db)).toBe(1);
    const { hits } = await searchCorpus(db, "auth");
    expect(hits).toHaveLength(1);
  });
});

describe("loadOrRebuild", () => {
  test("builds from buildDocs when no indexPath is given", async () => {
    const { count, rebuilt } = await loadOrRebuild({
      buildDocs: async () => [makeDoc(), makeDoc({ filePath: "packets/b.md" })],
    });
    expect(count).toBe(2);
    expect(rebuilt).toBe(true);
  });

  test("count is 0 for an empty corpus", async () => {
    const { count } = await loadOrRebuild({ buildDocs: async () => [] });
    expect(count).toBe(0);
  });

  test("persists to indexPath on first build, then loads it (no rebuild)", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pi-warm-lor-"));
    const indexPath = join(dir, "index.json");

    let buildCalls = 0;
    const buildDocs = async () => {
      buildCalls++;
      return [makeDoc()];
    };

    const first = await loadOrRebuild({ buildDocs, indexPath });
    expect(first.rebuilt).toBe(true);
    expect(first.count).toBe(1);

    // Second call finds the persisted index and does NOT rebuild.
    const second = await loadOrRebuild({ buildDocs, indexPath });
    expect(second.rebuilt).toBe(false);
    expect(second.count).toBe(1);
    expect(buildCalls).toBe(1);
  });
});
