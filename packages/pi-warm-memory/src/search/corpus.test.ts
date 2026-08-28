import { describe, expect, test } from "vitest";
import {
  buildCorpusIndex,
  type CorpusDocument,
  createIndex,
  getIndexCount,
  indexDocument,
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
  for (const doc of docs) await indexDocument(db, doc);
  return db;
};

describe("searchCorpus", () => {
  test("ranks a keyword match above an unrelated packet", async () => {
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
    expect(hits[0]?.filePath).toContain("auth");
  });

  test("returns no hits for an unrelated query", async () => {
    const db = await seed([makeDoc()]);
    expect((await searchCorpus(db, "kubernetes helm chart")).hits).toEqual([]);
  });

  test("requires every requested tag", async () => {
    const db = await seed([
      makeDoc(),
      makeDoc({ tags: ["auth"], filePath: "packets/only-auth.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", {
      tags: ["auth", "backend"],
    });
    expect(hits.map((hit) => hit.filePath)).toEqual([
      "packets/2026/04/2026-04-17-handoff-auth.md",
    ]);
  });

  test("filters by packet kind", async () => {
    const db = await seed([
      makeDoc(),
      makeDoc({ source: "checkpoint", filePath: "packets/cp.md" }),
    ]);
    const { hits } = await searchCorpus(db, "auth", {
      source: "checkpoint",
    });
    expect(hits.map((hit) => hit.filePath)).toEqual(["packets/cp.md"]);
  });

  test("keeps packets on or after an inclusive date", async () => {
    const db = await seed([
      makeDoc({ date: "2026-04-30", filePath: "packets/before.md" }),
      makeDoc({ date: "2026-05-01", filePath: "packets/boundary.md" }),
      makeDoc({ date: "2026-06-01", filePath: "packets/after.md" }),
    ]);
    const { hits, count } = await searchCorpus(db, "auth", {
      since: "2026-05-01",
    });
    expect(count).toBe(2);
    expect(hits.map((hit) => hit.filePath).sort()).toEqual([
      "packets/after.md",
      "packets/boundary.md",
    ]);
  });

  test("rejects malformed dates", async () => {
    const db = await seed([makeDoc()]);
    await expect(
      searchCorpus(db, "auth", { since: "2026-5-1" }),
    ).rejects.toThrow("expected YYYY-MM-DD");
  });
});

describe("buildCorpusIndex", () => {
  test("rebuilds the disposable index from supplied packet metadata", async () => {
    const { db, count } = await buildCorpusIndex([
      makeDoc(),
      makeDoc({ filePath: "packets/b.md" }),
    ]);
    expect(count).toBe(2);
    expect(await getIndexCount(db)).toBe(2);
  });

  test("supports an empty archive", async () => {
    const { db, count } = await buildCorpusIndex([]);
    expect(count).toBe(0);
    expect(await getIndexCount(db)).toBe(0);
  });
});
