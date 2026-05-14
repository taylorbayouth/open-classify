# Signal contracts

Stock classifier outputs are typed signals. Every classifier output must include `reason` (≤120 chars) and `certainty` as a number from 0 to 1. The aggregator drops below-threshold signals (default threshold: `0.65`).

```ts
type Certainty = number; // finite 0..1
```

## `preflight` — `FinalReplySignal | AckReplySignal`

```ts
{
  final_reply?: { reply: string };  // ≤200 chars; short-circuits to action=reply
  ack_reply?:   { reply: string };  // ≤200 chars; passthrough to caller
  reason: string;
  certainty: Certainty;
}
```

- Emit `final_reply` only for tiny terminal answers (greetings, thanks, simple arithmetic). Never for drafting, analysis, or generated work.
- Emit `ack_reply` when downstream work should continue and a courtesy acknowledgement helps.
- `final_reply` and `ack_reply` are mutually exclusive.
- A confident `final_reply` aborts the pipeline and returns `{ action: "reply", reply: { text } }`.

## `routing` — `RoutingSignal` (tier axis)

```ts
{
  model_tier?: "local_fast" | "local_small" | "local_strong" | "local_coding"
             | "frontier_fast" | "frontier_strong" | "frontier_coding";
  reason: string;
  certainty: Certainty;
}
```

Tier feeds the catalog resolver as a soft constraint.

## `model_specialization` — `RoutingSignal` (specialization axis)

```ts
{
  specialization?: "chat" | "reasoning" | "planning" | "writing" | "summarization"
                 | "coding" | "tool_use" | "computer_use" | "vision";
  reason: string;
  certainty: Certainty;
}
```

`routing` and `model_specialization` both contribute to downstream model resolution, but each owns one axis: `routing` owns `model_tier`; `model_specialization` owns `specialization`.

## `tools` — `ToolsSignal`

```ts
{
  tools: string[];
  reason: string;
  certainty: Certainty;
}
```

- An empty `tools` array means no downstream tools are required.
- `tools` must not contain duplicates.
- Allowed ids are declared per-manifest in `tools`. The built-in tools classifier ships with `workspace`, `web`, `communications`, `documents`, `spreadsheets`, `project_management`, `developer_platforms`.

## `prompt_injection` — `PromptInjectionSignal`

```ts
{
  risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  reason: string;
  certainty: Certainty;
}
```

This classifier is strictly about prompt injection: attempts to override higher-priority instructions, reveal hidden prompts, or make the assistant obey untrusted text as instructions. Destructive or sensitive ordinary requests are not prompt injection by themselves.

Short-circuit behavior:

- Confident `risk_level: "high_risk"` → `{ action: "block", reason: { kind: "prompt_injection", risk_level } }`.
- Confident `risk_level: "unknown"` → `{ action: "block", reason: { kind: "prompt_injection", risk_level } }`.

## Custom classifier output

Custom classifiers emit an opaque `output` value validated against `output_schema`:

```ts
{
  output: unknown;        // matches manifest output_schema
  reason: string;
  certainty: Certainty;
}
```

The aggregator never reads custom `output` when picking a route or model. It surfaces values on `result.classifier_outputs.<classifier_name>` and on `result.audit.custom_outputs[]`.
