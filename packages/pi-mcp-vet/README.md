# pi-mcp-vet

Deterministic, offline pre-connect vetting for MCP server descriptors. It never launches or connects to the described server.

## CLI

```sh
pi-mcp-vet server.json
cat server.json | pi-mcp-vet -
```

The CLI emits one versioned JSON decision. Exit codes: `0` allow, `2` ask for operator review, `1` deny, `64` usage error, `65` invalid or unsafe input.

## Descriptor

```json
{
  "name": "docs",
  "transport": "http",
  "url": "https://mcp.example.com/rpc",
  "capabilities": {
    "readOnly": true,
    "filesystem": "none",
    "network": "internet",
    "secrets": false
  }
}
```

Stdio descriptors use `command` and optional `args`. Optional `env` and `headers` values are validated but never copied into decisions. `roots`, `capabilities`, and `provenance` make privilege and supply-chain claims explicit.

## Decision

```json
{
  "version": 1,
  "subject": "mcp-connect",
  "effect": "allow",
  "score": 100,
  "server": { "name": "docs", "transport": "http" },
  "findings": []
}
```

High-severity findings deny. Medium findings require explicit operator approval. The extension registers the same evaluator as `mcp_vet` and `/mcp-vet` on Pi 0.84.2 and OMP 17.4.1/18.0.3.

## Scope

The scanner validates declared launch, transport, provenance, filesystem, network, and credential exposure. It does not attest that a descriptor is truthful, inspect package contents, connect to the server, or provide an OS sandbox.
