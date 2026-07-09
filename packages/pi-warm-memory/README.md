# pi-warm-memory

[![npm version](https://img.shields.io/npm/v/pi-warm-memory)](https://www.npmjs.com/package/pi-warm-memory) [![npm downloads](https://img.shields.io/npm/dm/pi-warm-memory)](https://www.npmjs.com/package/pi-warm-memory) [![License: MIT](https://img.shields.io/npm/l/pi-warm-memory)](https://www.npmjs.com/package/pi-warm-memory)

> Cross-session episodic memory for [pi](https://github.com/earendil-works/pi) agents.
>
> **"pi loses your context between sessions. This fixes it."**

pi gives an agent two memory layers: **hot** (the live session) and **cold** (durable
project memory). There is no layer for *episodic work history* — "we decided X, we're
blocked on Y, the next step is Z." When a session ends, that state vanishes. The next
session starts cold even on a problem it worked yesterday.

**pi-warm-memory adds the missing third layer — the *warm* layer:**

```
HOT ──session ends──► WARM ──aging/relevance──► COLD
(live)            (handoff &                (permanent
                    checkpoint packets)       project memory)
```

- **At session end:** `/archive-session` writes a structured **handoff packet**
  (decisions, blockers, next step, tags) to a searchable archive.
  `/archive-session checkpoint` writes a lighter **checkpoint packet** for
  mid-workstream snapshots.
- **At session start:** `/recall <query>` ranks the archive by relevance and surfaces the
  top packets to read, so the agent reconstructs *only the relevant* prior context — then
  continues fresh. (A **retrieval protocol** rule reminds it to do this before non-trivial
  work on an existing topic.)

No server, no external vector DB. The durable store is still an append-only JSONL you can
`grep` and `git diff` — that stays the source of truth. Search runs over a **disposable
in-memory index** ([Orama](https://github.com/oramasearch/orama), pure JS) rebuilt from the
JSONL on demand; BM25 keyword ranking is the default and embeddings/hybrid search are
opt-in. The LLM does the summarization (the hard part); retrieval is cheap and always fresh.

## Install

Published on npm as [`pi-warm-memory`](https://www.npmjs.com/package/pi-warm-memory):

```
pi install npm:pi-warm-memory
```

On first `/archive-session` the index header is seeded automatically — no postinstall step.

## Usage

### `/archive-session [instruction]`

Archives the current session as a **handoff packet**. The agent reviews the conversation
and fills a structured template:

```
/archive-session hand off the auth refactor work
/archive-session summarize the disk usage optimization
```

### `/archive-session checkpoint [instruction]`

Same mechanism, lighter template — focused on *what changed since the last checkpoint*:

```
/archive-session checkpoint mid-refactor state before the API redesign
```

### `/recall <query> [--tags a,b] [--since YYYY-MM-DD] [--kind handoff|checkpoint]`

Searches prior packets and surfaces the most relevant, so a fresh session can continue
where an old one left off. Ranking (BM25) runs in code; the command returns the ranked
packet paths plus instructions telling the agent which 1–3 to `read` and reconstruct —
it doesn't dump every packet into context.

```
/recall auth refactor
/recall session validator --tags auth,backend
/recall payments migration --since 2026-06-01 --kind handoff
```

- `--tags a,b` — require all listed tags (AND).
- `--since YYYY-MM-DD` — only packets on or after the date.
- `--kind handoff|checkpoint` — restrict to one packet kind.

The index is rebuilt from `index.jsonl` on each call, so recall is always current with no
manual reindex step.

## Packet formats

### Handoff packet (full — for ending a session or workstream)

```markdown
# Handoff Packet

- Thread ID:
- Parent Thread ID:
- Timestamp:
- Repo/CWD:
- Topic:
- Goal:
- Decisions Made:
- Files Touched:
- Commands Run:
- Blockers:
- Open Questions:
- Next Recommended Step:
- Tags:
- Compact Summary:
```

### Checkpoint packet (light — for mid-workstream snapshots)

```markdown
# Checkpoint Packet

- Thread ID:
- Timestamp:
- Current Task:
- What Changed Since Last Checkpoint:
- Files Touched:
- Current Risk:
- Pending Decisions:
- Immediate Next Step:
- Tags:
- Brief Summary:
```

## How it works

`/archive-session` is a **prompt-builder, not a summarizer** — the model that lived the
session summarizes it (one call, no context transfer, no drift between "what the session
did" and "what the packet says"). The command:

1. Parses the packet kind (`handoff` / `checkpoint`) and the user instruction.
2. Collects machine context — session thread ID, git repo / branch / commit / files-touched,
   timestamp.
3. Reads the matching template and returns a prompt instructing the agent to fill it from
   the conversation, write the packet to `history/packets/YYYY/MM/`, and append **one** JSON
   line to the index.

The agent then writes the packet + index entry with its normal file tooling.

## The index (`index.jsonl`)

Append-only, one JSON object per line. Line 1 is a header, written once and never modified:

```json
{"version":1,"kind":"thread-index","entries":[]}
```

Each subsequent line is a packet reference:

```json
{
  "version": 1,
  "kind": "packet-ref",
  "packetKind": "handoff",
  "threadId": "019dc293-286f-7000-bdee-8e943b88d6a5",
  "timestamp": "2026-05-05T05:47:04.250Z",
  "repo": "my-project",
  "cwd": "/home/me/code/my-project",
  "path": "packets/2026/05/2026-05-05T05-47-04.250Z-handoff-auth-refactor.md",
  "topic": "auth refactor",
  "tags": ["auth", "backend"],
  "files": ["src/auth.ts"],
  "summary": "Replaced the session-cookie auth with JWT"
}
```

`path` is relative to the history root, so an index is portable across machines.

## Configuration

The history directory is configurable via the `historyDir` setting (see `package.json` →
`pi.settings`) or its env fallback:

| Setting | Env | Default | Notes |
|---|---|---|---|
| `historyDir` | `PI_WARM_HISTORY_DIR` | `.pi/history` (project-local) | Absolute path, or relative to the project root. |

```sh
# project-local (default, shareable via git): .pi/history
# user-global: export PI_WARM_HISTORY_DIR="$HOME/.pi/history"
```

## Retrieval protocol

The bundled rule (`rules/retrieval-protocol.md`) becomes part of the agent's context:
before non-trivial work on an existing topic it runs `/recall <topic>`, opens the
top-ranked packets, and reconstructs only the relevant prior context. It also carries an
**isolation guardrail**: don't enable subagents / async delegation until handoff packets
are being written consistently — fragmented work without a retrieval contract *increases*
context loss.

## License

MIT
