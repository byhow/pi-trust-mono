# pi-model-choice

A thin Pi/OMP adapter for model-picker's stable `model-picker.selection` v1 contract. It recommends models; it never changes the active model.

## Prerequisite

Install a `model-picker` release that supports:

```sh
model-picker pick --task agent --limit 5 --contract
```

By default the adapter resolves `model-picker` from `PATH`. To pin an exact launcher, set `PI_MODEL_PICKER_BIN` to an absolute path ending in `model-picker` or `mp`.

## Commands

```text
/model-choice agent
/model-choice coding
/model-choice review
```

The `model_choice` tool also accepts optional filters, limits, and speed/price/context weights. Every request is passed as argv without shell evaluation. Output is accepted only when it matches the bounded version-1 envelope.

## Scope

The package owns adapter validation and host registration only. Ranking, model data, and recommendation semantics remain in model-picker. A recommendation is advisory and does not authorize a model switch or expose provider credentials.
