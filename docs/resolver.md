# Aggregation and model resolution

The aggregator merges classifier outputs into an `Envelope`, picks a concrete model from the catalog, and returns a `PipelineResult`.

## Certainty threshold

Default: `0.65`. Configurable via `aggregator.certaintyThreshold` on `classifyOpenClassifyInput`. `aggregator.confidenceThreshold` remains as a deprecated compatibility alias.

Per-classifier signals are emitted with `certainty` tags. The aggregator maps those tags to scores:

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

Signals with scores below the threshold, or missing certainty, are dropped from aggregation. Dropped routing axes are reported on `audit.model_recommendation.resolution.constraints_dropped` with `reason: "low_confidence"`.

Custom classifier outputs are surfaced regardless of certainty (callers can decide what to do with them), but the value still goes through schema validation.

## Whole-run certainty gate

Before returning a normal `route`, the pipeline calculates mapped certainty scores for every classifier result, including custom classifiers. Missing certainty and fallback outputs without certainty count as `0`.

`aggregator.certaintyGate` controls whether low whole-run certainty becomes `action: "block"`:

- `min_score` (default) — compare the lowest classifier score to `certaintyThreshold`.
- `avg_score` — compare the arithmetic mean of all classifier scores to `certaintyThreshold`.
- `off` — do not block based on whole-run certainty.

When this gate fires, `fired_by` is `"certainty_gate"` and `reason` / `audit.certainty_gate` include `kind: "low_certainty"`, the mode, threshold, observed score, per-classifier scores, and low classifier names.

## Routing axis merge

`routing` and `model_specialization` both emit partial `RoutingSignal` shapes. For each axis (`model_tier`, `specialization`), the aggregator picks the highest-scored confident value among the two classifiers. Tier comes from `routing`; specialization comes from `model_specialization` — but either classifier may emit either axis.

## Short-circuits

The pipeline aborts early when:

1. `preflight.final_reply` is present with certainty score ≥ threshold → `{ action: "reply", reply: { text } }`.
2. `prompt_injection.risk_level === "high_risk"` with certainty score ≥ threshold → `{ action: "block" }`.
3. `prompt_injection.risk_level === "unknown"` with certainty score ≥ threshold → `{ action: "block" }`.

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
- `result.audit.custom_outputs` is the same data with `reason` and `certainty` metadata attached.
