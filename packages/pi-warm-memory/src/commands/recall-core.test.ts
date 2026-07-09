import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SearchHit } from "../search/corpus.ts";
import { formatHits, HELP, parseArgs, runRecall } from "./recall-core.ts";

/* ---------------------------------------------------------------------------
 * parseArgs — pure arg splitting
 * ------------------------------------------------------------------------- */
describe("parseArgs", () => {
  test("treats bare words as the query", () => {
    const { query, filters } = parseArgs(["auth", "token", "refactor"]);
    expect(query).toBe("auth token refactor");
    expect(filters).toEqual({});
  });

  test("parses --tags into a trimmed, non-empty list", () => {
    const { filters } = parseArgs(["auth", "--tags", "auth, backend ,, "]);
    expect(filters.tags).toEqual(["auth", "backend"]);
  });

  test("omits tags when the value is empty", () => {
    const { filters } = parseArgs(["auth", "--tags", ""]);
    expect(filters.tags).toBeUndefined();
  });

  test("parses --since and --kind", () => {
    const { filters } = parseArgs([
      "auth",
      "--since",
      "2026-05-01",
      "--kind",
      "checkpoint",
    ]);
    expect(filters.since).toBe("2026-05-01");
    expect(filters.source).toBe("checkpoint");
  });

  test("keeps query words that surround flags", () => {
    const { query, filters } = parseArgs([
      "session",
      "--tags",
      "auth",
      "validator",
    ]);
    expect(query).toBe("session validator");
    expect(filters.tags).toEqual(["auth"]);
  });

  test("returns an empty query when given no terms", () => {
    expect(parseArgs([]).query).toBe("");
    expect(parseArgs(["--tags", "auth"]).query).toBe("");
  });
});

/* ---------------------------------------------------------------------------
 * formatHits — pure rendering
 * ------------------------------------------------------------------------- */
describe("formatHits", () => {
  const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
    title: "auth",
    date: "2026-06-01",
    source: "handoff",
    filePath: "packets/a.md",
    excerpt: "did the auth work",
    score: 3.14159,
    tags: ["auth", "backend"],
    ...over,
  });

  test("numbers hits, rounds the score, and joins tags", () => {
    const out = formatHits([hit()]);
    expect(out).toContain("1. [3.1] packets/a.md");
    expect(out).toContain("handoff · 2026-06-01 · tags: auth, backend");
    expect(out).toContain("did the auth work");
  });

  test("uses placeholders for empty date/tags/excerpt", () => {
    const out = formatHits([hit({ date: "", tags: [], excerpt: "" })]);
    expect(out).toContain("no date");
    expect(out).toContain("tags: —");
    expect(out).toContain("(no summary)");
  });

  test("separates multiple hits with a blank line", () => {
    const out = formatHits([
      hit({ filePath: "a.md" }),
      hit({ filePath: "b.md" }),
    ]);
    expect(out).toContain("1. ");
    expect(out).toContain("2. ");
    expect(out.split("\n\n")).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------------------
 * runRecall — end-to-end over a real temp archive
 * ------------------------------------------------------------------------- */
const header = '{"version":1,"kind":"thread-index","entries":[]}';
const ref = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    kind: "packet-ref",
    packetKind: "handoff",
    timestamp: "2026-06-01T10:00:00.000Z",
    path: "packets/2026/06/auth.md",
    topic: "auth token refactor",
    tags: ["auth", "backend"],
    files: ["src/session-validator.ts"],
    summary: "Split the session validator.",
    ...over,
  });

const archive = async (lines: readonly string[]): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-warm-recall-"));
  const historyDir = join(cwd, ".pi", "history");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(historyDir, { recursive: true });
  await writeFile(join(historyDir, "index.jsonl"), lines.join("\n"), "utf8");
  return cwd;
};

describe("runRecall", () => {
  test("returns HELP when no query is given", async () => {
    const cwd = await archive([header, ref()]);
    expect(await runRecall([], cwd)).toBe(HELP);
  });

  test("reports the empty-archive case", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-warm-none-"));
    const out = await runRecall(["auth"], cwd);
    expect(out).toContain("nothing to recall");
  });

  test("surfaces a ranked result for a matching query", async () => {
    const cwd = await archive([header, ref()]);
    const out = await runRecall(["auth"], cwd);
    expect(out).toContain("# Recall: auth");
    expect(out).toContain("packets/2026/06/auth.md");
    expect(out).toContain("BM25 relevance");
    expect(out).toContain("## Instructions");
  });

  test("reports no-match when the query hits nothing", async () => {
    const cwd = await archive([header, ref()]);
    const out = await runRecall(["kubernetes"], cwd);
    expect(out).toContain("No packets matched");
    expect(out).toContain("1 indexed");
  });

  test("gracefully surfaces a malformed --since instead of throwing", async () => {
    const cwd = await archive([header, ref()]);
    const out = await runRecall(["auth", "--since", "last tuesday"], cwd);
    expect(out).toContain("Invalid `since`");
    expect(out).toContain(HELP);
  });

  test("applies --kind to narrow results", async () => {
    const cwd = await archive([
      header,
      ref({ packetKind: "handoff", path: "packets/h.md" }),
      ref({ packetKind: "checkpoint", path: "packets/c.md" }),
    ]);
    const out = await runRecall(["auth", "--kind", "checkpoint"], cwd);
    expect(out).toContain("packets/c.md");
    expect(out).not.toContain("packets/h.md");
  });
});
