# Signal contracts

Stock classifier outputs are typed signals. Every output may carry optional `reason` (≤120 chars) and `confidence` (0–1). Below-threshold signals are dropped from aggregation (default threshold: `0.6`).

## `preflight` — `FinalReplySignal | AckReplySignal`

```ts
{
  final_reply?: { reply: string };  // ≤200 chars; short-circuits to action=answer
  ack_reply?:   { reply: string };  // ≤200 chars; passthrough to caller
  reason?: string;
  confidence?: number;
}
```

- Emit `final_reply` only for tiny terminal answers (greetings, thanks, simple arithmetic). Never for drafting, analysis, or generated work.
- Emit `ack_reply` when downstream work should continue and a courtesy acknowledgement helps.
- `final_reply` and `ack_reply` are mutually exclusive.
- A confident `final_reply` aborts the pipeline and returns `{ action: "answer", reply }`.

## `routing` — `RoutingSignal` (tier axis)

```ts
{
  model_tier?: "local_fast" | "local_small" | "local_strong" | "local_coding"
             | "frontier_fast" | "frontier_strong" | "frontier_coding";
  reason?: string;
  confidence?: number;
}
```

Tier feeds the catalog resolver as a soft constraint.

## `model_specialization` — `RoutingSignal` (specialization axis)

```ts
{
  specialization?: "chat" | "writing" | "reasoning" | "planning" | "coding"
                 | "instruction_following" | /* ... full enum in src/enums.ts ... */;
  reason?: string;
  confidence?: number;
}
```

`routing` and `model_specialization` both emit partial `RoutingSignal` shapes. The aggregator picks the highest-confidence value per axis.

## `tools` — `ToolsSignal`

```ts
{
  tools: string[];
  reason?: string;
  confidence?: number;
}
```

- An empty `tools` array means no downstream tools are required.
- `tools` must not contain duplicates.
- Allowed ids are declared per-manifest in `tools`. The built-in tools classifier ships with `workspace`, `web`, `communications`, `documents`, `spreadsheets`, `project_management`, `developer_platforms`.

## `security` — `SafetySignal`

```ts
{
  decision?: "allow" | "block" | "needs_review";
  risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  signals: string[];
  reason?: string;
  confidence?: number;
}
```

Validation:

- `normal` and `unknown` must have an empty `signals` array.
- `suspicious` and `high_risk` must include at least one signal.
- `decision: "block"` requires `risk_level: "high_risk"`.
- `decision: "allow"` must not use `risk_level: "high_risk"`.

Short-circuit behavior:

- Confident `decision: "block"` → `{ action: "block", reason: { risk_level, signals } }`.
- Confident `decision: "needs_review"` → `{ action: "needs_review", reason: { risk_level, signals } }`.

Built-in signal vocabulary: `instruction_attack`, `secret_or_private_data_risk`, `unsafe_tool_or_action`, `untrusted_content_or_code`, `injection_or_obfuscation`.

## Custom classifier output

Custom classifiers emit an opaque `output` value validated against `output_schema`:

```ts
{
  output: unknown;        // matches manifest output_schema
  reason?: string;
  confidence?: number;
}
```

The aggregator never reads custom `output` when picking a route or model. It surfaces values on `result.classifier_outputs.<classifier_name>` and on `result.audit.custom_outputs[]`.
