# Aggregation and model resolution

The aggregator merges classifier outputs into an `Envelope`, picks a concrete model from the catalog, and returns a `PipelineResult`.

## Certainty threshold

Default: `0.65`. Configurable via `aggregator.certaintyThreshold` on `classifyOpenClassifyInput`.

Per-classifier outputs carry `certainty` tags. The aggregator maps tags to scores:

```ts
{
  no_signal: 0.00,
  very_weak: 0.15,
  weak: 0.30,
  tentative: 0.45,
  reasonable: 0.60,
  strong: 0.75,
  very_strong: 0.88,
  near_certain: 0.97,
}
```

Reserved-field values from below-threshold classifiers are dropped from the named envelope slots. The full underlying output still appears in `audit.classifier_outputs[]` and `audit.meta.classifiers[name]`, so the caller can inspect or override.

Dropped routing axes are reported on `audit.model_recommendation.resolution.constraints_dropped` with `reason: "low_confidence"`.

Custom (non-reserved) outputs are surfaced regardless of certainty — callers can decide what to do with them — but the value still goes through schema validation.

## Reserved-field merging

When multiple classifiers emit the same reserved field, the aggregator picks the highest-certainty contributor that meets the threshold. Ties are broken by manifest `dispatch_order` ascending (first wins). Classifiers without `dispatch_order` sort last for tie-break purposes.

The built-in classifiers each own a distinct reserved field, so the tie-break only matters if you add your own classifier that emits a field already covered by a built-in.

## Whole-run certainty summary

Every run includes `audit.meta.certainty.{min, avg}`. These are the lowest and arithmetic-mean certainty scores across all classifiers, including failed classifiers that fell back to their manifest fallback (which use `no_signal` and score 0).

The pipeline does not block based on this summary — the worker pool always returns a `route` action. Callers inspect `audit.meta.certainty` and decide whether to trust the result or fall back to a safer behavior (e.g., force a frontier model, return an apology).

## Model resolution

Inputs:

- `model_specialization` (soft) — must be in the model's `specializations[]`.
- `model_tier` (soft) — must equal the model's `tier`.

Resolution passes (first non-empty match wins):

1. model_specialization + model_tier
2. model_specialization only
3. model_tier only
4. no constraints

Within a pass, candidates are ranked:

1. lowest **price index** (`input_tokens_cpm + output_tokens_cpm`, or `0` if pricing is absent)
2. larger `params_in_billions`
3. larger `context_window`
4. earlier catalog order

If every pass returns no candidates, the resolver returns `catalog.default` with `fell_back_to_default: true`. (In practice the no-constraints pass always finds at least one model unless the catalog is empty, so the default-fallback path is defensive.)

## Resolution audit

Every result carries a resolution report:

```ts
{
  constraints_used: { model_specialization?: ..., model_tier?: ... },
  constraints_dropped: Array<{
    axis: "model_specialization" | "model_tier",
    reason: "low_confidence" | "no_match_relaxed" | "default_fallback"
  }>,
  confidences: { routing?: number },
  fell_back_to_default: boolean,
}
```

Drop reasons:

- `low_confidence` — a classifier emitted the axis but its certainty was below threshold.
- `no_match_relaxed` — the axis was requested but no model matched, so the resolver relaxed it.
- `default_fallback` — every pass failed; the resolver used `catalog.default`.

## Audit envelope

The full `audit` envelope contains:

- Reserved-field slots that survived the certainty threshold: `final_reply`, `ack_reply`, `routing`, `tools`, `prompt_injection`
- `classifier_outputs[]` — every classifier's full output, in registry order, including `reason`, `certainty`, all reserved fields, and all custom fields
- `model_recommendation` with the resolution audit above
- `meta.classifiers[name]` — per-classifier full output plus `status` and `version`
- `meta.certainty.{min, avg}` — whole-run certainty summary
