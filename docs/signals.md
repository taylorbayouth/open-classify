# Reserved field reference

Every classifier output is shaped as `{ reason, certainty, ...payload }`. The payload may contain any combination of **reserved fields** (well-known output keys the aggregator knows how to consume) and **custom fields** defined by the classifier's own `output_schema`.

```ts
type Certainty =
  | "no_signal"
  | "very_weak"
  | "weak"
  | "tentative"
  | "reasonable"
  | "strong"
  | "very_strong"
  | "near_certain";
```

The aggregator maps certainty tags to numeric scores. Reserved-field values from classifiers below the configured threshold (default `0.65`) are dropped from the envelope; the underlying output still appears in `audit.classifier_outputs` and `meta.classifiers` so the caller can decide whether to trust the run.

## Reserved fields

A manifest declares which reserved fields its classifier may emit via the `reserved_fields` array. The runtime then injects the canonical sub-schema and prompt fragment for each one, so the LLM is told the exact shape and enum values to use. You can't accidentally emit an invalid value, and you can't accidentally drift from the canonical enum list.

### `final_reply`

```ts
{ text: string }  // 1–200 chars; must contain at least one non-whitespace character
```

Use only for tiny terminal answers (greetings, thanks, spelling, simple arithmetic). The text IS the complete answer to the user — nothing else happens after this. Mutually exclusive with `ack_reply`.

When emitted with sufficient certainty, the highest-certainty value is surfaced in `audit.final_reply`. The pipeline does not short-circuit; the caller decides whether to return the reply or continue to the downstream model.

### `ack_reply`

```ts
{ text: string }  // 1–200 chars; must contain at least one non-whitespace character
```

A brief acknowledgement to show while downstream work continues. Surfaced in `audit.ack_reply`. Mutually exclusive with `final_reply`.

### `model_tier`

```ts
"local_fast" | "local_small" | "local_strong" | "local_coding"
| "frontier_fast" | "frontier_strong" | "frontier_coding"
```

Soft constraint for the catalog resolver. The model resolver picks the cheapest catalog entry whose `tier` matches, relaxing the constraint when nothing fits.

### `model_specialization`

```ts
"chat" | "reasoning" | "planning" | "writing" | "summarization"
| "coding" | "tool_use" | "computer_use" | "vision"
```

Soft constraint for the catalog resolver. The resolver picks the cheapest catalog entry whose `specializations[]` includes the value.

### `tools`

```ts
string[]   // each id must appear in the manifest's allowed_tools list
```

Sets `downstream.tools.tools`. Any classifier emitting this reserved field must declare `allowed_tools` on its manifest — that menu of allowed ids becomes both the JSON Schema constraint and the prompt listing.

Common tool-id aliases (`browser`, `browsing`, `internet`, `web_browsing`, `web_search`) are normalized to `web` before validation, so the model can drift on phrasing without breaking.

### `risk_level`

```ts
"normal" | "suspicious" | "high_risk" | "unknown"
```

Prompt-injection posture for the target message. Surfaced in `audit.prompt_injection`. The pipeline does not short-circuit; the caller decides whether to block based on the risk level and certainty.

## Custom fields

Anything not in the reserved list lives in your manifest's `output_schema.properties`. The runtime validates each output against the composed schema (custom properties + reserved sub-schemas + `reason` + `certainty`) at runtime, and surfaces the full output on `result.classifier_outputs[name]` with `reason` and `certainty` stripped for ergonomic access. The full output, including metadata, appears in `result.audit.classifier_outputs[]` and `result.audit.meta.classifiers[name]`.

## Picking between reserved-field contributors

When two classifiers declare the same reserved field, the aggregator picks the highest-certainty value above the threshold. Ties are broken by manifest `dispatch_order` ascending (first in registry order keeps the slot). Both classifiers' full outputs still appear in `audit.classifier_outputs` regardless of which one "won" the slot.
