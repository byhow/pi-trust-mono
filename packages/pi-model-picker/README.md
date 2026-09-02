# @byhow/pi-model-picker

Thin Pi/OMP adapter for the model-picker decision plane.

It invokes one reviewed absolute `model-picker` launcher, requests `model-picker.selection` v1, validates the complete response against the canonical producer schema, and presents the result as advisory data. It does not rank models, fetch provider data, mutate host settings, or switch the active model.

## Install

```sh
pi install npm:@byhow/pi-model-picker
```

The same package manifest is consumed by OMP.

## Reviewed configuration

```sh
export PI_MODEL_PICKER_BIN=/absolute/reviewed/path/model-picker
```

The adapter rejects relative paths and launcher aliases. The binary must be named `model-picker` and must support:

```sh
model-picker pick --task agent --limit 5 --contract
```

## Surfaces

- `/model-picker [agent|coding|review|vision|budget|long-context|fast]`
- `model_picker` diagnostic tool with bounded task/filter/limit/weight inputs

Both return recommendation data only. They never change the active model without explicit user action.

## Canonical contract

The package contains the exact `model-picker.selection` v1 schema and fixture shipped by the producer release. The schema artifact is digest-pinned in adapter tests. Every launcher response must:

- pass the canonical schema;
- contain no extra properties;
- have `count === choices.length`;
- return no more choices than the request limit.

Invalid JSON, oversized output, schema drift, launcher failure, and non-zero exit fail without a recommendation.

## Supported hosts

| Host | Verified version |
|---|---|
| Pi | 0.84.2 |
| OMP | 17.4.1 and 18.1.4 |

Compile-time host interface checks live only under `test/`; they are not included in the published package. Packed registration is tested separately against each exact host.
