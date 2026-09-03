# pi-sisyphus

Thin Pi/OMP adapter for the Sisyphus trust plane.

It owns host integration and presentation, plus the opt-in publication of
redacted receipts for the closed Fleet Lab canary catalog:

- awaits Sisyphus before every non-diagnostic tool call;
- proceeds only on a valid `allow` decision with the matching request ID and exit code;
- blocks `deny`, `ask`, `modify`, invalid output, timeout, launcher failure, and unsafe configuration;
- exposes `/permit` and `sisyphus_policy` for diagnostics;
- exposes `/mcp-vet` and `mcp_vet` as static Vet Evidence presentation;
- attests an exactly matching Fleet Lab canary decision and terminal result only on the real tool-call path.

Policy evaluation, Policy Bundle verification, MCP vet logic, general decision
logging, and authorization remain in Sisyphus. The adapter cannot mint a
receipt for caller-defined actions or from its diagnostic surfaces.

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

## Fleet Lab canary receipts

The real `tool_call` hook can optionally emit one redacted Fleet Lab attestation for a closed, package-owned public canary. The diagnostic tool and commands never emit attestations. Arming is all-or-nothing:

```sh
export PI_SISYPHUS_CANARY_MODE=fleet-lab-v1
export PI_SISYPHUS_CANARY_ACTION=read-only-scout
export PI_SISYPHUS_CANARY_CHALLENGE=<fresh-43-character-base64url-value>
export PI_SISYPHUS_CANARY_RECEIPT_DIR=/absolute/precreated/private/empty-directory
export PI_SISYPHUS_CANARY_POLICY_ID=sisyphus://bundle/v1
```

The parent runner must create a fresh challenge and an owned `0700` receipt directory outside the contender worktree for every trial. Challenges and policy IDs are bounded public identifiers; control characters and credential-shaped values fail closed before publication. The package accepts only the five definitions in [`canary-actions.json`](./canary-actions.json). It compares the normalized tool, exact JSON input, and classified resource scope; request ID and working-directory spelling are deliberately not action identity. The public definition digest is SHA-256 over the UTF-8 bytes of the manifest definition after removing `definitionDigest` and serializing the remaining keys in their checked-in order.

Every accepted matching invocation first produces a separate `attestation-<uuid>.json` file. Only after an `allow` receipt is durably published does the package arm an in-memory correlation for that native tool-call ID. A matching `tool_result` consumes the correlation exactly once and produces `completion-<uuid>.json`; denied, ask, modify, engine-failure, non-target, and diagnostic calls never arm completion. Reused IDs, more than 16 pending correlations, mismatched tools, ambiguous result metadata, duplicate or missing results, completion publication failure, and results arriving after session shutdown fail closed by producing no completion receipt.

Both receipt kinds use the same publisher: an exclusive no-follow `0600` temporary file, file `fsync`, sealing to `0400`, same-directory no-overwrite hard linking, directory `fsync`, and owner/mode/device/inode revalidation. The directory is capped at 32 total receipts. A decision-publication or provenance failure blocks even an otherwise valid `allow` result. A completion-publication failure cannot undo an already executed tool, so the parent runner treats a missing completion as a failed trial. The parent accepts exactly one current-challenge decision and its matching completion; duplicates, stale challenges, late receipts, malformed files, and unknown contract versions fail the trial.

Receipt content is the strict `zoysia.fleet-lab.sisyphus-attestation` version-1 contract: public action ID/version/definition digest, challenge, public policy ID, actual aggregate bundle digest, and either decision effect or a closed engine failure code. It never contains the request ID, tool, input, path, working directory, reason, modified input, credentials, or any hash derived from live input. General Sisyphus decision logging is unchanged.

Completion content is the separate strict `zoysia.fleet-lab.sisyphus-completion` version-1 contract. It repeats only the public action descriptor, challenge, policy ID, and aggregate bundle digest, then records `success` or `tool-error-or-cancelled`. The Pi/OMP `tool_result` hook exposes one error bit rather than a trustworthy distinct cancellation bit, so the adapter deliberately keeps error and cancellation in one closed outcome. It never reads or persists result content, details, input, request ID, or paths. Session shutdown clears correlations and never claims completion.

Receipt construction and completion correlation are package-private. Public `evaluateTrust` results retain their original decision-or-failure shape and never expose receipt provenance. Only the extension's real intercepted `tool_call` and `tool_result` path obtains aggregate bundle provenance from the Sisyphus configuration and may invoke the private recorder; injected diagnostic evaluators, `sisyphus_policy`, `/permit`, `mcp_vet`, and `/mcp-vet` cannot mint receipts.

This filesystem protocol protects against accidental replacement, links, collisions, partial writes, and stale trial evidence. It does not claim isolation from arbitrary malicious code running as the same operating-system user; stronger adversaries require a separate broker or sandbox boundary.

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
