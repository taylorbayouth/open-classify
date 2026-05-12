# Aggregation and model resolution

The aggregator merges classifier outputs into an `Envelope`, picks a concrete model from the catalog, and returns a `PipelineResult`.

## Confidence threshold

Default: `0.6`. Configurable via `aggregator.confidenceThreshold` on `classifyOpenClassifyInput`.

Per-classifier signals with `confidence < threshold` (or missing confidence, treated as `0`) are dropped from aggregation. Dropped routing axes are reported on `audit.model_recommendation.resolution.constraints_dropped` with `reason: "low_confidence"`.

Custom classifier outputs are surfaced regardless of confidence (callers can decide what to do with them), but the value still goes through schema validation.

## Routing axis merge

`routing` and `model_specialization` both emit partial `RoutingSignal` shapes. For each axis (`model_tier`, `specialization`), the aggregator picks the highest-confidence confident value among the two classifiers. Tier comes from `routing`; specialization comes from `model_specialization` — but either classifier may emit either axis.

## Short-circuits

The pipeline aborts early when:

1. `preflight.final_reply` is present with confidence ≥ threshold → `{ action: "answer", reply }`.
2. `security.decision === "block"` with confidence ≥ threshold → `{ action: "block" }`.
3. `security.decision === "needs_review"` with confidence ≥ threshold → `{ action: "needs_review" }`.

Preflight is evaluated first (it's cheaper to gate). Only these two stock signals can short-circuit; custom classifiers cannot.

## Model resolution

Inputs:

- `specialization` (soft) — must be in the model's `specializations[]`.
- `model_tier` (soft) — must equal the model's `tier`.

Resolution passes (first non-empty match wins):

1. specialization + tier
2. specialization only
3. tier only
4. no constraints

Within a pass, candidates are ranked:

1. lowest **price index** (`input_tokens_cpm + output_tokens_cpm`, or `0` if pricing is absent)
2. larger `params_in_billions`
3. larger `context_window`
4. earlier catalog order

If every pass returns no candidates, the resolver returns `catalog.default` with `fell_back_to_default: true`. (In practice the no-constraints pass always finds at least one model unless the catalog is empty, so the default-fallback path is defensive.)

## Resolution audit

Every `route` result carries a resolution report:

```ts
{
  constraints_used: { specialization?: ..., tier?: ... },
  constraints_dropped: Array<{
    axis: "specialization" | "tier",
    reason: "low_confidence" | "no_match_relaxed" | "default_fallback"
  }>,
  confidences: { routing?: number },
  fell_back_to_default: boolean,
}
```

Drop reasons:

- `low_confidence` — the classifier emitted the axis but below threshold.
- `no_match_relaxed` — the axis was requested but no model matched, so the resolver relaxed it.
- `default_fallback` — every pass failed; the resolver used `catalog.default`.

## Custom outputs

After aggregation:

- `result.classifier_outputs` is a flat `Record<name, unknown>` of validated custom outputs.
- `result.audit.custom_outputs` is the same data with `reason` and `confidence` metadata attached.
