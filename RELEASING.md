# Release checklist

Publication, Git tags, and host activation are attended operations on the
designated release computer. Source verification must not read live OMP auth,
settings, sessions, or transcripts.

## Package identities

- `pi-sisyphus@0.1.0`
- `@byhow/pi-model-picker@0.1.0`

The unscoped `pi-model-picker` name is not available: an unrelated maintainer
published `pi-model-picker@1.0.0` before this adapter release. The adapter uses
the `@byhow` scope so its package identity cannot be confused with that product.
Do not publish this source under the unscoped name.

## Source and host gates

From a clean checkout with Node 24 and npm 11.16.x:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run verify:lockfile
npm run verify:contracts
npm run verify:registration
npm run verify:pack
npm run lint
npm run typecheck
npm run test:coverage
```

Run the packed behavioral matrix with checksum-verified official release
artifacts for OMP 17.4.1 and OMP 18.1.4. The Pi 0.84.2 lane installs the exact
registry version with npm's registry-integrity verification enabled. Each lane
must load the packed packages, register every declared surface, and invoke every
command handler:

```sh
PI_MATRIX_HOST=pi PI_MATRIX_BIN=/absolute/pi npm run verify:behavioral-host
PI_MATRIX_HOST=omp PI_MATRIX_BIN=/absolute/omp-17.4.1 npm run verify:behavioral-host
PI_MATRIX_HOST=omp PI_MATRIX_BIN=/absolute/omp-18.1.4 npm run verify:behavioral-host
```

Run the real producer processes through the public adapter interfaces:

```sh
PI_PRODUCT_SISYPHUS_BIN=/absolute/sy \
PI_PRODUCT_MODEL_PICKER_BIN=/absolute/model-picker \
  npm run verify:product-integration
```

## Attended registry checks and publication

Immediately before publication, the owner must confirm the intended npm
identity and `@byhow` scope access without printing registry credentials:

```sh
npm whoami --registry=https://registry.npmjs.org
npm access list packages @byhow --json
npm view pi-sisyphus versions --json --registry=https://registry.npmjs.org
npm view @byhow/pi-model-picker versions --json --registry=https://registry.npmjs.org
```

The expected pre-publication state is that neither exact `0.1.0` version exists.
Review both dry-run payloads, then use the repository's Changesets release
command with the public registry explicitly selected. Do not publish from an
agent session:

```sh
npm pack --json --dry-run --workspace pi-sisyphus
npm pack --json --dry-run --workspace @byhow/pi-model-picker
npm_config_registry=https://registry.npmjs.org npm run release
```

Read back the immutable registry artifacts and their integrity values:

```sh
npm view pi-sisyphus@0.1.0 version dist.integrity --registry=https://registry.npmjs.org
npm view @byhow/pi-model-picker@0.1.0 version dist.integrity --registry=https://registry.npmjs.org
```

Only after those readbacks pass may Mist pin
`npm:pi-sisyphus@0.1.0` and `npm:@byhow/pi-model-picker@0.1.0` for attended
reconciliation.
