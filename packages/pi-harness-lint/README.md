# pi-harness-lint

Deterministic static linting for explicit agent-harness capability descriptors. It reads supplied JSON only; it never inspects live auth, settings, sessions, credentials, or processes.

## CLI

```sh
pi-harness-lint harness.json
cat harness.json | pi-harness-lint -
```

Exit codes: `0` no warning/error findings, `2` warnings, `1` errors, `64` usage error, `65` invalid or unsafe input.

## Descriptor

```json
{
  "version": 1,
  "name": "bounded-agent",
  "approvalMode": "manual",
  "bashDenyPatterns": 4,
  "tools": [
    { "name": "read", "effect": "read", "sandboxed": true, "network": "none" }
  ],
  "mcp": [{ "name": "docs", "vetted": true }],
  "autonomy": {
    "subagents": true,
    "isolatedWorktrees": true,
    "maxIterations": 20
  }
}
```

The rules cover YOLO tripwires, unsandboxed execution, direct network access, duplicate tools, unvetted MCP servers, sensitive transcript permissions, metadata-only journals, subagent isolation, autonomy bounds, and model-visible credentials.

The Pi/OMP extension exposes the same engine through `harness_lint` and `/harness-lint`.

## Scope

A report scores declared architecture; it does not prove that runtime behavior matches the descriptor. Use installed-runtime tests, MCP vet decisions, and policy enforcement separately.
