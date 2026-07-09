---
"pi-warm-memory": minor
---

Add `/recall <query>` — the retrieval half of the warm layer. Ranks prior handoff/checkpoint packets by BM25 relevance (with `--tags`, `--since`, and `--kind` filters) and surfaces the top matches for the agent to read, completing the write (`/archive-session`) + read (`/recall`) loop.

The search index is a disposable in-memory Orama index rebuilt from `index.jsonl` on each call, so `index.jsonl` remains the durable, git-diffable source of truth. BM25 keyword ranking is the default; embeddings/hybrid search are opt-in via an `EmbedFunction`.
