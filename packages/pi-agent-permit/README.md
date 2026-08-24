# pi-agent-permit

A fail-closed Pi/OMP adapter for the vendor-neutral [sisyphus](https://github.com/byhow/sisyphus) `input -> decision` policy contract.

## Required configuration

```sh
export PI_TRUST_BUNDLE_DIR=/absolute/path/to/reviewed/bundles
# Optional exact launcher override; otherwise `sy` is resolved from PATH.
export PI_TRUST_ENGINE_BIN=/absolute/path/to/sy
```

Installing the package activates a `tool_call` hook. Missing bundles, an unavailable engine, invalid output, `deny`, `ask`, and `modify` all block execution. Only an explicit, valid `allow` proceeds.

`ask` remains blocked until an operator approves the exact call through an external attended workflow. `modify` remains blocked until the rewritten input is reviewed and resubmitted. The adapter never infers either as authorization.

## Diagnostics

The `agent_permit` tool evaluates a hypothetical call without executing it. `/permit <tool-name>` evaluates empty input. The package's own diagnostic tool bypasses its hook solely to avoid recursion.

The adapter sends exact tool input to the local policy process over stdin. It passes a sanitized environment and forces `TRUST_ENGINE_LOG_PATH=/dev/null`, so sisyphus cannot persist raw tool arguments through its CLI decision logger. Decisions are bounded and schema-checked before use.

## Scope

This package is an enforcement adapter, not the policy engine, approval UI, or OS sandbox. Policy bundles remain reviewed external data owned by sisyphus.
