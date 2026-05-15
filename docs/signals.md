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

The aggregator maps certainty tags to numeric scores. `classifier_outputs[name].certainty` is a float; `avg_certainty` and `min_certainty` on the top-level result are also floats. Certainty labels are internal to classifier prompts; floats are what callers see.

## Reserved fields

A manifest declares which reserved fields its classifier may emit via the `reserved_fields` array. The runtime then injects the canonical sub-schema and prompt fragment for each one, so the LLM is told the exact shape and enum values to use. You can't accidentally emit an invalid value, and you can't accidentally drift from the canonical enum list.

### `final_reply`

```ts
{ text: string }  // 1–200 chars; must contain at least one non-whitespace character
```

Use only for tiny terminal answers (greetings, thanks, spelling, simple arithmetic). The text IS the complete answer — nothing else happens after this. Mutually exclusive with `ack_reply`.

When emitted, the pipeline sets `action: "reply"` and surfaces the text in `result.reply`. All other classifiers still run to completion.

### `ack_reply`

```ts
{ text: string }  // 1–200 chars; must contain at least one non-whitespace character
```

A brief, task-specific acknowledgement to show while downstream work continues. Mutually exclusive with `final_reply`.

When emitted (and the action is `"route"`), the text is surfaced in `result.reply`. This is the immediate response your UI can show while the downstream model works.

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

Sets `result.tools`. Any classifier emitting this reserved field must declare `allowed_tools` on its manifest — that menu of allowed ids becomes both the JSON Schema constraint and the prompt listing.

Common tool-id aliases (`browser`, `browsing`, `internet`, `web_browsing`, `web_search`) are normalized to `web` before validation, so the model can drift on phrasing without breaking.

`result.tools` is always an array (empty if no classifier emitted it or no tools were selected).

### `risk_level`

```ts
"normal" | "suspicious" | "high_risk" | "unknown"
```

Prompt-injection posture for the target message. Surfaced in `result.prompt_injection`.

`"high_risk"` and `"unknown"` trigger `action: "block"` with `block_reason: "prompt_injection"`, regardless of certainty. `"suspicious"` is advisory — the pipeline routes normally and the caller decides whether to act on it.

When the `prompt_injection` classifier fails (runtime error or timeout), it uses its fallback which does **not** include `risk_level`. The pipeline then blocks with `block_reason: "classification_error"`, not `"prompt_injection"` — a classifier failure is distinct from an assessed injection risk.

## Custom fields

Anything not in the reserved list lives in your manifest's `output_schema.properties`. The runtime validates each output against the composed schema (custom properties + reserved sub-schemas + `reason` + `certainty`) at runtime, and surfaces the full output on `result.classifier_outputs[name]`.

`classifier_outputs[name]` contains all payload fields plus `reason` (string) and `certainty` (float). The raw certainty label is not exposed; only the float score.

## Picking between reserved-field contributors

When two classifiers declare the same reserved field, the aggregator picks the highest-certainty value. Ties are broken by manifest `dispatch_order` ascending (first in registry order keeps the slot). Both classifiers' full outputs still appear in `classifier_outputs` regardless of which one "won" the slot.
