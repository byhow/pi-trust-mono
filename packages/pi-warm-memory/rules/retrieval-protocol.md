# Retrieval Protocol

Before ending or handing off non-trivial work, preserve the session state with `/archive-session` or `/archive-session checkpoint`.

Before doing non-trivial work on an existing topic:

1. Run `/recall <topic>` to rank prior packets by relevance. Narrow with `--tags a,b`, `--since YYYY-MM-DD`, or `--kind handoff|checkpoint` when helpful.
2. Read the top 1–3 packets it surfaces — not all of them.
3. Use those packets to reconstruct only the relevant prior context.
4. Continue in a fresh session instead of relying on the full old transcript.

Packet files live under `history/packets/YYYY/MM/`; `history/index.jsonl` stays append-only, with the original header object preserved on line 1. `/recall` rebuilds its search index from `index.jsonl` on each call, so it is always current — there is no manual reindex step.

Use project memory for durable facts.
Use handoff/checkpoint packets for episodic work history.

## Isolation Guardrail

Do not enable isolated subagents or async swarm-style delegation for complex workstreams until handoff and checkpoint packets are being created consistently.
Fragmented work without a retrieval contract increases context loss instead of reducing it.
