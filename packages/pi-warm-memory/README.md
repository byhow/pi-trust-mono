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

No server, no external vector DB. The durable source of truth is append-only
`index.jsonl` plus Markdown packet files. Recall rebuilds a disposable in-memory
[Orama](https://github.com/oramasearch/orama) BM25 index on demand. There is no
embedding provider, vector cache, or hidden synchronization path.

## Install

Published on npm as [`pi-warm-memory`](https://www.npmjs.com/package/pi-warm-memory):

```
pi install npm:pi-warm-memory
```

On first `/archive-session` the index header is seeded automatically — no postinstall step.

## Supported hosts

| Host | Tested version | Package behavior |
|---|---|---|
| Oh My Pi | 17.4.1 and 18.1.4 | Commands and conventional retrieval rule; configure the history root with `PI_WARM_HISTORY_DIR` |
| Pi | 0.84.2 | Commands; configure the history root with `PI_WARM_HISTORY_DIR` |

Other host versions are not claimed until their packed-package conformance test passes.


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

Searches prior packets and surfaces the most relevant packet metadata plus up to three
bounded packet bodies, so a fresh session can continue where an old one left off.
Ranking runs locally with BM25; archived bodies are framed as untrusted data before
they reach the model.

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
- Timestamp:
- Repository:
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

`/archive-session` is a **prompt-builder, not a summarizer**. The model that lived
the session derives bounded structured fields from the conversation. The command:

1. Requires a persisted host session.
2. Parses the packet kind (`handoff` / `checkpoint`) and user instruction.
3. Collects session identity and bounded Git repository context.
4. Reads the matching packet template and asks the model to call
   `warm_memory_archive` exactly once.
5. The extension-owned tool validates lengths, relative paths, line structure, and
   common secret patterns before writing a private packet and atomically appending
   its index reference.

The model never writes archive or index files through normal file/shell tools.

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
  "path": "packets/2026/05/2026-05-05T05-47-04.250Z-handoff-auth-refactor.md",
  "topic": "auth refactor",
  "tags": ["auth", "backend"],
  "files": ["src/auth.ts"],
  "summary": "Replaced the session-cookie auth with JWT"
}
```

`path` is relative to the history root, so an index is portable across machines.

## Configuration

The history directory is configurable through the `PI_WARM_HISTORY_DIR` environment variable:

| Setting | Env | Default | Notes |
|---|---|---|---|
| N/A | `PI_WARM_HISTORY_DIR` | `.pi/history` (project-local) | Absolute path, or a path confined below the project root. |
| N/A | `PI_WARM_ALLOW_GIT_TRACKING` | unset | Set to `1` or `true` only to opt out of the default private `.gitignore`. |

```sh
# project-local and private by default: .pi/history
# user-global: export PI_WARM_HISTORY_DIR="$HOME/.pi/history"
```

## Retrieval protocol

OMP discovers the bundled `rules/retrieval-protocol.md` through its conventional plugin
capability directories. It reminds the agent to run `/recall <topic>`, open only the top
ranked packets, and reconstruct relevant prior context. Upstream Pi loads the commands but
does not currently claim automatic rule parity; apply the same protocol through your Pi
instructions when desired.

The rule also carries an **isolation guardrail**: do not enable subagents or asynchronous
delegation until handoff packets are written consistently, because fragmented work without
a retrieval contract increases context loss.

## License

MIT
