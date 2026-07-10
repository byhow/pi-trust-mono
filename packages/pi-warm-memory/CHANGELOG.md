# pi-warm-memory

## 0.1.0

### Minor Changes

- 3d9379f: Add `/recall <query>` — the retrieval half of the warm layer. Ranks prior handoff/checkpoint packets by BM25 relevance (with `--tags`, `--since`, and `--kind` filters) and surfaces the top matches for the agent to read, completing the write (`/archive-session`) + read (`/recall`) loop.

  The search index is a disposable in-memory Orama index rebuilt from `index.jsonl` on each call, so `index.jsonl` remains the durable, git-diffable source of truth. BM25 keyword ranking is the default; embeddings/hybrid search are opt-in via an `EmbedFunction`.

### Patch Changes

- 505b838: Deepen `/archive-session` into a thin adapter over a pure, fully-tested core.

  - Extract `src/commands/archive-core.ts` — `parseArchiveArgs` + `buildArchivePrompt`, pure and deterministic (timestamp injected, no pi-runtime import). Mirrors the existing `recall-core` split.
  - Extract `src/git-context.ts` — `gatherGitContext` adapter over an injected `exec` (real `api.exec` in prod, fake in tests) plus a pure `parseStatusLines`.
  - Rewrite `archive-session.ts` as the thin adapter: gathers inputs, delegates to `buildArchivePrompt`. Deletes the duplicated `resolveHistoryDir` (now imported from `paths.ts`).
  - Add `archive-core.test.ts` + `git-context.test.ts`; new modules at 100% coverage.
  - Fix: the first file in the "Files touched" list previously lost its first character — `git status --short` output was whole-blob `trim()`-ed, stripping the leading status-code space of the first line and shifting the path slice. Now `trimEnd()`.

## 0.0.2

### Patch Changes

- Mark `@oh-my-pi/pi-coding-agent` peer dependency as optional via `peerDependenciesMeta`, so installation no longer errors when the agent package isn't present.
