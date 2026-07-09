/**
 * pi-warm-memory — the retrieval half of the warm layer, as pure logic.
 *
 * `/recall <query>` ranks prior handoff/checkpoint packets by BM25 relevance and
 * returns the top matches plus instructions telling the agent which packets to
 * read. Deterministic ranking lives here; judgment (what's relevant, what to
 * reconstruct) stays with the model. `index.jsonl` is never mutated — the Orama
 * index is rebuilt from it on each call.
 *
 * This module has NO dependency on the pi runtime, so every branch is unit
 * testable. `recall.ts` is a thin adapter that feeds it `ctx.cwd`.
 */
import { buildPacketDocs } from "../packets.ts";
import { resolveHistoryDir } from "../paths.ts";
import {
  loadOrRebuild,
  type SearchFilters,
  type SearchHit,
  searchCorpus,
} from "../search/corpus.ts";

export const HELP =
  "Usage: /recall <query> [--tags a,b] [--since YYYY-MM-DD] [--kind handoff|checkpoint]";

/** How many packets to surface per recall. */
export const RECALL_LIMIT = 8;

/** Split raw args into a free-text query and structured filters. */
export const parseArgs = (
  args: readonly string[],
): { query: string; filters: SearchFilters } => {
  const terms: string[] = [];
  let tags: readonly string[] | undefined;
  let since: string | undefined;
  let source: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tags") {
      tags = (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--since") {
      since = args[++i];
    } else if (a === "--kind") {
      source = args[++i];
    } else {
      terms.push(a);
    }
  }

  const filters: SearchFilters = {
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(since ? { since } : {}),
    ...(source ? { source } : {}),
  };
  return { query: terms.join(" ").trim(), filters };
};

/** Render ranked hits as a numbered, human-readable list. */
export const formatHits = (hits: readonly SearchHit[]): string =>
  hits
    .map((h, i) => {
      const tags = h.tags.length > 0 ? h.tags.join(", ") : "—";
      return (
        `${i + 1}. [${h.score.toFixed(1)}] ${h.filePath}\n` +
        `   ${h.source} · ${h.date || "no date"} · tags: ${tags}\n` +
        `   ${h.excerpt || "(no summary)"}`
      );
    })
    .join("\n\n");

/**
 * Run a recall against the packet archive rooted at `cwd`. Returns the text the
 * command surfaces to the user/agent. Never throws — validation and empty-state
 * cases return an explanatory string.
 */
export const runRecall = async (
  args: readonly string[],
  cwd: string,
): Promise<string> => {
  const { query, filters } = parseArgs(args);
  if (!query) return HELP;

  const historyDir = resolveHistoryDir(cwd);

  // index.jsonl is the source of truth; the Orama index is a disposable cache
  // rebuilt each call (fast for a personal archive, always fresh, no staleness).
  const { db, count: indexed } = await loadOrRebuild({
    buildDocs: () => buildPacketDocs(historyDir),
  });
  if (indexed === 0) {
    return `No packets under ${historyDir} yet — nothing to recall. Use /archive-session to create one.`;
  }

  let hits: readonly SearchHit[];
  let matches: number;
  try {
    const result = await searchCorpus(db, query, filters, RECALL_LIMIT);
    hits = result.hits;
    matches = result.count;
  } catch (err) {
    // e.g. a malformed --since value; surface it instead of crashing.
    return `${err instanceof Error ? err.message : String(err)}\n\n${HELP}`;
  }

  if (hits.length === 0) {
    return `No packets matched "${query}" (${indexed} indexed). Try broader terms or drop a --tags/--since/--kind filter.`;
  }

  return `# Recall: ${query}

Top ${hits.length} of ${matches} matching packets (BM25 relevance):

${formatHits(hits)}

## Instructions
1. Read the 1–3 packets above most relevant to "${query}" with the read tool (use the paths shown).
2. Reconstruct ONLY the relevant prior context — decisions, blockers, and the next recommended step.
3. Skip packets that don't fit the current task; don't read them all.
4. Continue the work in this fresh session using what you reconstructed.`;
};
