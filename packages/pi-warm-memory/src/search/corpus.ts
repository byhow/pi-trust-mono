import type { AnyOrama, Results } from "@orama/orama";
import { count, create, insert, search } from "@orama/orama";

export const corpusSchema = {
  title: "string",
  content: "string",
  date: "string",
  tags: "enum[]",
  source: "enum",
  filePath: "string",
  excerpt: "string",
} as const;

export type CorpusDocument = {
  readonly title: string;
  readonly content: string;
  /** ISO date (or "") used for `--since` range filtering. */
  readonly date: string;
  readonly tags: readonly string[];
  readonly source: "handoff" | "checkpoint";
  readonly filePath: string;
  readonly excerpt: string;
};

export type SearchFilters = {
  readonly tags?: readonly string[];
  readonly source?: string;
  readonly since?: string;
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
};

export const createIndex = async (): Promise<AnyOrama> =>
  create({ schema: corpusSchema });

export const indexDocument = async (
  db: AnyOrama,
  doc: CorpusDocument,
): Promise<void> => {
  await insert(db, {
    title: doc.title,
    content: doc.content,
    date: doc.date,
    tags: [...doc.tags],
    source: doc.source,
    filePath: doc.filePath,
    excerpt: doc.excerpt,
  });
};

/** Search the disposable in-memory packet index with BM25 and bounded filters. */
export const searchCorpus = async (
  db: AnyOrama,
  query: string,
  filters?: SearchFilters,
  limit = 10,
): Promise<SearchResult> => {
  if (filters?.since && !/^\d{4}-\d{2}-\d{2}$/.test(filters.since)) {
    throw new Error(
      `Invalid \`since\` value "${filters.since}"; expected YYYY-MM-DD.`,
    );
  }

  const where: Record<string, unknown> = {};
  if (filters?.tags && filters.tags.length > 0) {
    where.tags = { containsAll: [...filters.tags] };
  }
  if (filters?.source) {
    where.source = { eq: filters.source };
  }

  const fetchLimit = filters?.since ? Math.max(limit * 10, 100) : limit;
  const result: Results<CorpusDocument> = await search(db, {
    term: query,
    ...(Object.keys(where).length > 0 ? { where } : {}),
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
  let matchedCount = result.count;

  if (filters?.since) {
    const since = filters.since;
    const matched = hits.filter((hit) => hit.date >= since);
    matchedCount = matched.length;
    hits = matched.slice(0, limit);
  }

  return { hits, count: matchedCount };
};

export const getIndexCount = async (db: AnyOrama): Promise<number> => count(db);

/** Rebuild the disposable index from the durable packet metadata. */
export const buildCorpusIndex = async (
  docs: readonly CorpusDocument[],
): Promise<{ readonly db: AnyOrama; readonly count: number }> => {
  const db = await createIndex();
  for (const doc of docs) await indexDocument(db, doc);
  return { db, count: docs.length };
};
