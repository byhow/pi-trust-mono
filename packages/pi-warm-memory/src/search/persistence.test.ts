import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createIndex, getIndexCount, indexDocument } from "./corpus.ts";
import { loadIndex, saveIndex } from "./persistence.ts";

const tmpIndexPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-warm-persist-"));
  return join(dir, "search-index.json");
};

const seededIndex = async () => {
  const db = await createIndex();
  await indexDocument(db, {
    title: "auth token refactor",
    content: "Split the session validator.",
    date: "2026-04-17",
    tags: ["auth"],
    source: "handoff",
    filePath: "packets/a.md",
    excerpt: "auth work",
  });
  return db;
};

describe("saveIndex / loadIndex", () => {
  test("round-trips an index to disk and back", async () => {
    const indexPath = await tmpIndexPath();
    const db = await seededIndex();
    const written = await saveIndex(db, indexPath);
    expect(written).toBe(indexPath);

    const fresh = await createIndex();
    const result = await loadIndex(fresh, indexPath);
    expect(result.loaded).toBe(true);
    expect(await getIndexCount(fresh)).toBe(1);
  });

  test("creates parent directories on save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-warm-nested-"));
    const indexPath = join(dir, "deep", "nested", "index.json");
    const db = await seededIndex();
    await expect(saveIndex(db, indexPath)).resolves.toBe(indexPath);

    const fresh = await createIndex();
    expect((await loadIndex(fresh, indexPath)).loaded).toBe(true);
  });

  test("reports not-found for a missing index file", async () => {
    const db = await createIndex();
    const result = await loadIndex(
      db,
      join(tmpdir(), "does-not-exist-xyz.json"),
    );
    expect(result).toEqual({ loaded: false, reason: "not-found" });
  });

  test("reports corrupted for invalid JSON", async () => {
    const indexPath = await tmpIndexPath();
    await writeFile(indexPath, "{ not valid json", "utf8");
    const db = await createIndex();
    const result = await loadIndex(db, indexPath);
    expect(result).toEqual({ loaded: false, reason: "corrupted" });
  });

  test("reports corrupted when the payload is not an object", async () => {
    const indexPath = await tmpIndexPath();
    await writeFile(indexPath, "42", "utf8");
    const db = await createIndex();
    const result = await loadIndex(db, indexPath);
    expect(result).toEqual({ loaded: false, reason: "corrupted" });
  });
});
