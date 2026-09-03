# pi-trust-mono

Trust, safety, and reliability tooling for AI agents.

## Packages

| Package | Version | Type | Install |
|---|---|---|---|
| [pi-warm-memory](packages/pi-warm-memory/) | [![npm version](https://img.shields.io/npm/v/pi-warm-memory)](https://www.npmjs.com/package/pi-warm-memory) | pi extension (cross-session memory) | `pi install npm:pi-warm-memory` |
| [pi-sisyphus](packages/pi-sisyphus/) | 0.1.0 release candidate | Pi/OMP adapter for Sisyphus Trust Decisions, MCP Vet Evidence, and closed Fleet Lab decision/completion receipts | `pi install npm:pi-sisyphus` |
| [@byhow/pi-model-picker](packages/pi-model-picker/) | 0.1.0 release candidate | Pi/OMP adapter for canonical model-picker recommendations | `pi install npm:@byhow/pi-model-picker` |

## Development

```bash
npm install                        # install workspace dependencies
npm run lint                       # Biome checks
npm run typecheck                  # Pi + OMP development type probes
npm run test:coverage              # package behavioral contracts
npm run verify:contracts           # public package invariants
npm run verify:registration        # manifest ↔ extension registration
npm run verify:pack                # npm payload allowlists
PI_MATRIX_HOST=pi PI_MATRIX_BIN=/absolute/pi npm run verify:behavioral-host
PI_PRODUCT_SISYPHUS_BIN=/absolute/sy \
PI_PRODUCT_MODEL_PICKER_BIN=/absolute/model-picker \
  npm run verify:product-integration # real product processes through adapters
```

The release-candidate manifests lock publication to the public npm registry.
Publication, tags, and host activation remain attended release-computer actions.
See [RELEASING.md](RELEASING.md) for the exact registry and evidence checklist.
