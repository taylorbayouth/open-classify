# Aggregation and model resolution

The aggregator merges classifier outputs into a `PipelineResult` with a flat shape — no nested `audit` or `downstream` envelope.

## Certainty labels

Classifier outputs carry a `certainty` label. The aggregator maps labels to numeric scores for comparison and reporting:

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

Labels stay in classifier prompts (the model understands them as semantic grades). Floats appear only in the final `PipelineResult` fields: `avg_certainty`, `min_certainty`, and `classifier_outputs[name].certainty`.

## Reserved-field merging

When multiple classifiers emit the same reserved field, the aggregator picks the highest-certainty contributor. Ties are broken by manifest `dispatch_order` ascending (first wins). Classifiers without `dispatch_order` sort last for tie-break purposes.

There is no certainty threshold gate — the highest-certainty value always wins, regardless of score. Values below any particular threshold are still reported in `classifier_outputs` for the caller to inspect.

## Action

Every result has `action: "route" | "block" | "reply"`.

**`"reply"`** — `preflight` emitted `final_reply`. The classifier determined it can answer the message immediately; no downstream model is needed. `result.reply` contains the text. All other classifiers still ran.

**`"block"`** — something prevented routing. `result.block_reason` names the cause:
- `"prompt_injection"` — `risk_level` is `"high_risk"` or `"unknown"`, regardless of certainty. This takes priority over other causes.
- `"classification_error"` — one or more classifiers failed or timed out, or preflight provided no reply (which means the pipeline cannot fulfill its reply contract), or no model could be resolved.

**`"route"`** — all classifiers succeeded and `result.model_id` names the downstream model to call.

Even on `"block"`, `model_id` and `reply` are populated when they can be (the caller may want to store them). `failed_classifiers` lists every classifier that errored or timed out.

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

If every pass returns no candidates, the resolver uses `catalog.default`. In practice the no-constraints pass always finds at least one model unless the catalog is empty, so the default-fallback path is defensive.

## Whole-run certainty summary

Every run includes `avg_certainty` and `min_certainty` at the top level of `PipelineResult`. These are the arithmetic mean and minimum certainty scores across all classifiers, including failed classifiers that fell back to their manifest fallback (which use `no_signal` and score `0`).

The pipeline does not block based on these values — the caller inspects them and decides whether to trust the result or fall back to a safer behavior.
