# pi-sisyphus

Thin Pi/OMP adapter for the Sisyphus trust plane.

It owns host registration and presentation only:

- awaits Sisyphus before every non-diagnostic tool call;
- proceeds only on a valid `allow` decision with the matching request ID and exit code;
- blocks `deny`, `ask`, `modify`, invalid output, timeout, launcher failure, and unsafe configuration;
- exposes `/permit` and `sisyphus_policy` for diagnostics;
- exposes `/mcp-vet` and `mcp_vet` as static Vet Evidence presentation.

Policy evaluation, Policy Bundle verification, MCP vet logic, and decision logging remain in Sisyphus.

## Install

```sh
pi install npm:pi-sisyphus
```

The same package manifest is consumed by OMP.

## Reviewed configuration

The launcher and bundle are operator deployment inputs, not agent choices:

```sh
export PI_SISYPHUS_BIN=/absolute/reviewed/path/sy
export PI_SISYPHUS_BUNDLE_DIR=/absolute/read-only/policy-bundle
export PI_SISYPHUS_BUNDLE_DIGEST=<64-lowercase-hex-digest>
# Optional metadata-only log owned by Sisyphus:
export PI_SISYPHUS_DECISION_LOG=/absolute/private/decisions.jsonl
```

Relative paths, a launcher not named `sy`, malformed digests, timeouts, oversized I/O, mismatched request IDs, and mismatched decision exit codes fail closed.

## Tool-call semantics

Only `allow` authorizes the exact intercepted call. `ask` is not silently converted into a prompt; it remains blocked pending an external attended approval path. `modify` remains blocked until the exact replacement is reviewed and resubmitted.

The read-only diagnostic tools bypass recursive interception because they do not execute the hypothetical action or connect to an MCP server.

## MCP vet

```text
/mcp-vet {"name":"docs","transport":"http","url":"https://mcp.example.test/rpc"}
```

The adapter sends the bounded descriptor to `sy vet mcp -` and accepts only version-1 Vet Evidence. Output contains credential key names, never header or environment values. Evidence is advisory and never authorizes a connection.

## Supported hosts

| Host | Verified version |
|---|---|
| Pi | 0.84.2 |
| OMP | 17.4.1 and 18.1.4 |

Compile-time host interface checks live only under `test/`; they are not shipped as a compatibility facade. Packed-package registration is verified separately against each exact host.
