/**
 * Generic BM25 + optional-hybrid search over a document corpus.
 *
 * Project-agnostic by design:
 *  - `source` is a free-form string (the caller defines its own kinds)
 *  - the corpus is supplied by a `buildDocs()` callback, not a hardcoded dir scan
 *  - the persistence path is injected, not hardcoded
 *
 * The Orama index is a *disposable derived cache*. In pi-warm-memory the durable
 * source of truth stays `index.jsonl` (append-only, git-diffable); this index is
 * rebuilt from it on demand. BM25 is the default; embeddings/hybrid are opt-in.
 */

import type { AnyOrama, Results } from "@orama/orama";
import { count, create, insert, search } from "@orama/orama";
import { loadIndex, saveIndex } from "./persistence.ts";

/** Embedding width. all-MiniLM-L6-v2 = 384. Change if switching models. */
export const EMBEDDING_DIMENSIONS = 384;

// NOTE: `tags` and `source` are `enum`/`enum[]`, not `string`/`string[]`.
// Orama's filter operators (`eq`, `containsAll`) only apply to enum-indexed
// fields; on plain string fields a `where` clause silently matches nothing.
// Enums still hold arbitrary strings, so `source` stays caller-defined.
// `date` is a plain string and is range-filtered in JS (see searchCorpus).
export const corpusSchema = {
  title: "string",
  content: "string",
  date: "string",
  tags: "enum[]",
  source: "enum",
  filePath: "string",
  excerpt: "string",
  embedding: `vector[${EMBEDDING_DIMENSIONS}]`,
} as const;

export type CorpusDocument = {
  readonly title: string;
  readonly content: string;
  /** ISO date (or "") used for `--since` range filtering. */
  readonly date: string;
  readonly tags: readonly string[];
  /** Caller-defined kind, e.g. "handoff" | "checkpoint". */
  readonly source: string;
  /** A locator the agent can `read` — a file path or index reference. */
  readonly filePath: string;
  readonly excerpt: string;
  /** Precomputed embedding (EMBEDDING_DIMENSIONS long). Enables hybrid search. */
  readonly embedding?: readonly number[];
};

/**
 * Turn text into an embedding vector, or undefined to skip. Implement to enable
 * hybrid search; omit entirely for pure BM25.
 */
export type EmbedFunction = (
  text: string,
) => Promise<readonly number[] | undefined>;

export type SearchFilters = {
  readonly tags?: readonly string[];
  readonly source?: string;
  readonly since?: string;
  /** Query vector for hybrid search. Must be EMBEDDING_DIMENSIONS long (validated). */
  readonly vector?: readonly number[];
};

export type SearchHit = {
  readonly title: string;
  readonly date: string;
  readonly source: string;
  readonly filePath: string;
  readonly excerpt: string;
  readonly score: number;
  readonly tags: readonly string[];
};

export type SearchResult = {
  readonly hits: readonly SearchHit[];
  readonly count: number;
  readonly elapsed: number;
};

/** Create a new empty index with the corpus schema. */
export const createIndex = async (): Promise<AnyOrama> =>
  create({ schema: corpusSchema });

/**
 * Insert one document. If `embed` is provided and the doc has no embedding, an
 * embedding is computed from its title + content (best-effort; failures skip it).
 */
export const indexDocument = async (
  db: AnyOrama,
  doc: CorpusDocument,
  embed?: EmbedFunction,
): Promise<void> => {
  let embedding = doc.embedding;
  if (!embedding && embed) {
    try {
      embedding = await embed(`${doc.title}\n${doc.content}`);
    } catch {
      embedding = undefined;
    }
  }

  await insert(db, {
    title: doc.title,
    content: doc.content,
    date: doc.date,
    tags: [...doc.tags],
    source: doc.source,
    filePath: doc.filePath,
    excerpt: doc.excerpt,
    ...(embedding ? { embedding: [...embedding] } : {}),
  });
};

/** Search the corpus with BM25 keyword matching, faceted filters, optional hybrid. */
export const searchCorpus = async (
  db: AnyOrama,
  query: string,
  filters?: SearchFilters,
  limit = 10,
): Promise<SearchResult> => {
  if (filters?.vector && filters.vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Query vector has ${filters.vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
        "Ensure the embedding model matches the index (EMBEDDING_DIMENSIONS).",
    );
  }
  // Fail fast on a malformed `since`: an invalid value would otherwise pass the
  // lexicographic date compare below and silently filter out everything.
  if (filters?.since && !/^\d{4}-\d{2}-\d{2}/.test(filters.since)) {
    throw new Error(
      `Invalid \`since\` value "${filters.since}"; expected an ISO date like YYYY-MM-DD.`,
    );
  }

  // Orama's `where` handles tags/source (Radix `containsAll`/`eq`). It does NOT
  // support range operators on a string field, so `since` is applied as a JS
  // post-filter below rather than via `where.date` (which would silently match
  // nothing). See the `since` handling after the search call.
  const where: Record<string, unknown> = {};
  if (filters?.tags && filters.tags.length > 0) {
    where.tags = { containsAll: [...filters.tags] };
  }
  if (filters?.source) {
    where.source = { eq: filters.source };
  }

  // When post-filtering by date, fetch a larger candidate set first so the
  // `limit` slice isn't applied before the date filter (which would drop valid
  // matches). Personal archives are small, so a generous cap is cheap.
  const fetchLimit = filters?.since ? Math.max(limit * 10, 100) : limit;

  const result: Results<CorpusDocument> = await search(db, {
    term: query,
    ...(Object.keys(where).length > 0 ? { where } : {}),
    ...(filters?.vector
      ? {
          vector: { value: [...filters.vector], property: "embedding" },
          mode: "hybrid" as const,
        }
      : {}),
    limit: fetchLimit,
  });

  let hits: readonly SearchHit[] = result.hits.map((hit) => {
    const doc = hit.document;
    return {
      title: doc.title as string,
      date: doc.date as string,
      source: doc.source as string,
      filePath: doc.filePath as string,
      excerpt: doc.excerpt as string,
      score: hit.score,
      tags: (doc.tags ?? []) as readonly string[],
    };
  });

  // `count` is the total number of matches (used for "top N of M"). When a
  // date post-filter is active, Orama's own count reflects the pre-filter set,
  // so recompute it from the filtered candidates.
  let count = result.count;

  // ISO-8601 dates sort lexicographically, so a string compare is a valid
  // chronological "on or after" test.
  if (filters?.since) {
    const since = filters.since;
    const matched = hits.filter((h) => h.date >= since);
    count = matched.length;
    hits = matched.slice(0, limit);
  }

  return {
    hits,
    // NOTE: without a date filter, in hybrid mode Orama's count sums the
    // full-text and vector arms and may double-count a doc matched by both, so
    // treat it as an upper bound there. For the BM25 path it is exact.
    count,
    elapsed: result.elapsed?.raw ?? 0,
  };
};

/** Document count in the index. */
export const getIndexCount = async (db: AnyOrama): Promise<number> => count(db);

/**
 * Load a persisted index if `indexPath` is given and present; otherwise build a
 * fresh one from `buildDocs()`. When `indexPath` is provided, a freshly built
 * index is also persisted. Omit `indexPath` to rebuild every call (cheap for a
 * personal archive) and never touch disk.
 */
export const loadOrRebuild = async (opts: {
  readonly buildDocs: () => Promise<readonly CorpusDocument[]>;
  readonly indexPath?: string;
  readonly embed?: EmbedFunction;
}): Promise<{
  readonly db: AnyOrama;
  readonly count: number;
  readonly rebuilt: boolean;
}> => {
  const db = await createIndex();

  if (opts.indexPath) {
    const loaded = await loadIndex(db, opts.indexPath);
    if (loaded.loaded) {
      return { db, count: await getIndexCount(db), rebuilt: false };
    }
  }

  const docs = await opts.buildDocs();
  for (const doc of docs) {
    await indexDocument(db, doc, opts.embed);
  }

  if (opts.indexPath) {
    await saveIndex(db, opts.indexPath);
  }

  return { db, count: docs.length, rebuilt: true };
};
