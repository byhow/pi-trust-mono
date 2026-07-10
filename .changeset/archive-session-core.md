---
"pi-warm-memory": patch
---

Deepen `/archive-session` into a thin adapter over a pure, fully-tested core.

- Extract `src/commands/archive-core.ts` — `parseArchiveArgs` + `buildArchivePrompt`, pure and deterministic (timestamp injected, no pi-runtime import). Mirrors the existing `recall-core` split.
- Extract `src/git-context.ts` — `gatherGitContext` adapter over an injected `exec` (real `api.exec` in prod, fake in tests) plus a pure `parseStatusLines`.
- Rewrite `archive-session.ts` as the thin adapter: gathers inputs, delegates to `buildArchivePrompt`. Deletes the duplicated `resolveHistoryDir` (now imported from `paths.ts`).
- Add `archive-core.test.ts` + `git-context.test.ts`; new modules at 100% coverage.
- Fix: the first file in the "Files touched" list previously lost its first character — `git status --short` output was whole-blob `trim()`-ed, stripping the leading status-code space of the first line and shifting the path slice. Now `trimEnd()`.
