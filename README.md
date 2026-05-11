# Open Classify

<img src="open-classify-logo.png" alt="Open Classify logo" width="180">

Open Classify is a manifest-driven classifier runtime for deciding what should happen before a user message reaches a downstream assistant model.

The core idea is deliberately small:

- Each classifier lives in `src/classifiers/<name>/`.
- Each classifier owns a `manifest.json` and `prompt.md`.
- Every classifier output has the same required base fields: `reason` and `confidence`.
- Classifiers may emit a fixed set of stock fields that the pipeline knows how to merge.
- Classifier-specific data goes in opaque `output`, is validated with JSON Schema, and is passed through without being interpreted by the aggregator.

This keeps custom classifiers plug-and-play without turning manifests into a rules engine. Manifests describe what a classifier emits; they do not contain arbitrary transforms or aggregation logic.

## What It Does

Open Classify runs classifiers concurrently against the latest user message and the visible conversation window. The route result can then tell your application:

- whether to answer immediately or block before any downstream model call
- which downstream execution mode, model tier, and specialization fit the request
- whether the supplied conversation window is enough, and how many prior messages are useful
- which broad tool families should be exposed
- what language or locale hints were detected
- what safety posture applies
- what summaries are useful for logging or compaction
- which opaque custom outputs were produced by classifier-specific logic
- which concrete model id to use from your model catalog

The built-in classifiers are examples of this pattern, not special cases in the aggregator.

| Built-in classifier | Emits |
|---|---|
| `preflight` | `handoff` |
| `routing` | `routing.execution_mode`, `routing.model_tier` |
| `model_specialization` | `routing.specialization` |
| `conversation_history` | `context` |
| `tools` | `tools` |
| `memory_retrieval_queries` | custom `output: { queries: string[] }` |
| `security` | `safety`, optionally `handoff` |

## Install

```sh
npm install open-classify
```

Requires Node.js 18 or newer. The reference runner uses local Ollama with `gemma4:e4b-it-q4_K_M`; classifier-specific adapter models can be declared in manifests or overridden programmatically.

## Usage

```ts
import { classifyWithOllama, loadCatalog } from "open-classify";

const catalog = loadCatalog("downstream-models.json");

const result = await classifyWithOllama(
  {
    messages: [
      { role: "user", text: "Can you review the attached contract?" },
    ],
    attachments: [
      {
        filename: "contract.pdf",
        mime_type: "application/pdf",
        size_bytes: 840123,
      },
    ],
  },
  { catalog },
);
```

Input is intentionally narrow:

- `messages` is required and must end with the user message to classify.
- Messages are chronological, oldest to newest.
- Message roles are `user` or `assistant`; the final message is forced to `user`.
- Open Classify keeps whole messages only. It drops older context messages when the classifier payload budget is exceeded.
- At most 20 messages are retained for classification.
- `attachments` are metadata only: `filename`, `mime_type`, and `size_bytes`.
- Unknown input fields are rejected rather than passed through.

## Runtime Shape

Every classifier returns JSON with required base fields:

```ts
{
  reason: string;
  confidence: number;
}
```

Validation rules:

- `reason` is required and capped at 200 characters.
- `confidence` is required and must be between `0` and `1`.
- Any stock field must be declared by that classifier's manifest in `emits`.
- Any custom `output` must be declared by `emits.output: true` and validated by `output_schema`.
- Unknown top-level fields are rejected.

Classifiers should omit uncertain optional stock fields. They should not emit escape-hatch values like `unable_to_determine` in stock outputs.

## Stock Outputs

The stock fields are the only fields the aggregator understands. They are all optional per classifier, but must be declared in the classifier manifest before they can appear in output.

### `handoff`

Use `handoff` when a classifier wants to affect pipeline handoff behavior or user-facing status.

```ts
type HandoffSignal =
  | { kind: "route"; ack_reply?: string }
  | { kind: "final"; reply: string }
  | { kind: "block"; reason_code?: string };
```

How it is used:

- `kind: "route"` can carry `ack_reply`, a short acknowledgement the caller can show while downstream work continues.
- `kind: "final"` can short-circuit the whole pipeline when the emitting manifest declares that kind in `short_circuit.kinds`.
- `kind: "block"` can short-circuit the whole pipeline when the emitting manifest declares that kind in `short_circuit.kinds`.
- If multiple confident classifiers emit `handoff`, the aggregator prefers the classifier with the lowest manifest `order`; equal order breaks by higher confidence.

Built-in usage:

- `preflight` emits `handoff.kind: "route"` or `handoff.kind: "final"`.
- `security` emits `handoff.kind: "block"` for blocking safety cases.

### `routing`

Use `routing` to tell the model resolver what kind of downstream model is needed.

```ts
interface RoutingSignal {
  execution_mode?: "direct" | "tool_assisted" | "workflow";
  model_tier?: "local_fast" | "local_strong" | "frontier_fast" | "frontier_strong";
  specialization?: "chat" | "writing" | "reasoning" | "planning" | "coding" | "instruction_following";
}
```

How it is used:

- `execution_mode` is a hard resolver constraint.
- `model_tier` is a soft resolver preference.
- `specialization` is a soft resolver preference.
- Multiple classifiers may contribute different `routing` subfields.
- For each subfield, the aggregator picks the confident value from the lowest-order classifier that emitted that subfield; equal order breaks by higher confidence.
- Low-confidence routing fields are ignored and recorded in `model_recommendation.resolution.constraints_dropped`.

The resolver never accepts concrete model ids from classifiers. Classifiers describe the work; the catalog maps that description to a model id.

### `context`

Use `context` to describe whether the visible conversation window contains the context needed downstream.

```ts
type ContextSignal =
  | { status: "standalone" }
  | { status: "sufficient"; include_prior_messages: number }
  | { status: "insufficient" }
  | { status: "unknown" };
```

How it is used:

- `standalone`: the latest user message is enough by itself.
- `sufficient`: the supplied visible message window has everything needed; pass the newest `include_prior_messages` prior messages with the target message.
- `insufficient`: the supplied visible window is not enough; the caller may need older history, retrieval, or a clarification flow outside Open Classify.
- `unknown`: the classifier could not tell.

`include_prior_messages` is valid only with `status: "sufficient"`. The aggregator does not slice or attach messages to the result; it emits the recommendation and the caller decides how to build the downstream prompt.

### `tools`

Use `tools` to select broad tool families for downstream exposure.

```ts
interface ToolsSignal {
  required: boolean;
  families: string[];
}
```

How it is used:

- `required` must match whether `families` is non-empty.
- `families` must not contain duplicates.
- If the manifest defines `tool_families`, every emitted family must be one of those configured ids.
- The aggregator unions confident family lists and dedupes them.
- If any confident classifier emits `tools` with no families, the aggregate can be `{ required: false, families: [] }`.

Tool family ids are configurable per manifest. The built-in `tools` classifier uses:

```json
[
  "workspace",
  "web",
  "communications",
  "documents",
  "spreadsheets",
  "project_management",
  "developer_platforms"
]
```

### `response`

Use `response` for lightweight response-language hints.

```ts
interface ResponseSignal {
  language?: string;
  locale?: string;
}
```

How it is used:

- The aggregator passes the selected confident response signal through.
- `language` is the language the downstream assistant should answer in, such as `English` or `Spanish`.
- `locale` is the regional or formatting locale, such as `en-US` or `es-MX`.
- No built-in classifier currently emits this field, but it is available as stock output for custom classifiers.

### `safety`

Use `safety` for security and policy posture.

```ts
interface SafetySignal {
  risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  signals: string[];
}
```

How it is used:

- `normal` and `unknown` must have an empty `signals` array.
- `suspicious` and `high_risk` must include at least one signal.
- The aggregator keeps the highest risk level across confident classifier outputs.
- Safety signals are unioned and deduped.
- A classifier may pair `safety.risk_level: "high_risk"` with `handoff.kind: "block"` when its manifest declares block short-circuiting.

The built-in security signal values are:

```json
[
  "instruction_attack",
  "secret_or_private_data_risk",
  "unsafe_tool_or_action",
  "untrusted_content_or_code",
  "injection_or_obfuscation"
]
```

### `summary`

Use `summary` for compact logging, compaction, or observability strings.

```ts
interface SummarySignal {
  target_message?: string;
  conversation_window?: string;
}
```

How it is used:

- The aggregator passes the selected confident summary signal through.
- `target_message` is capped at 200 characters.
- `conversation_window` is capped at 800 characters.
- No built-in classifier currently emits this field, but it is available as stock output for custom classifiers.

### `output`

Use `output` for classifier-specific data that Open Classify should validate and pass through but never interpret.

```ts
{
  reason: string;
  confidence: number;
  output: unknown;
}
```

Rules:

- `emits.output` must be `true`.
- `output_schema` is required.
- `output_schema` is JSON Schema validated by Ajv.
- The aggregator does not merge, transform, or read `output`.
- Route results expose custom outputs as:

```ts
custom_outputs: Array<{
  classifier: string;
  reason: string;
  confidence: number;
  output: unknown;
}>
```

Built-in usage:

```json
{
  "classifier": "memory_retrieval_queries",
  "reason": "The user refers to saved preferences.",
  "confidence": 0.9,
  "output": {
    "queries": ["user client update style"]
  }
}
```

## Aggregation

The aggregator is generic. It does not know about `preflight`, `routing`, `security`, or any other classifier by name.

On route results it outputs:

```ts
{
  decision: "route";
  target_message_hash: string;
  handoff?: HandoffSignal;
  routing?: RoutingSignal;
  context?: ContextSignal;
  tools?: ToolsSignal;
  response?: ResponseSignal;
  safety?: SafetySignal;
  summary?: SummarySignal;
  custom_outputs: CustomClassifierOutput[];
  model_recommendation: ModelRecommendation;
  meta: {
    classifiers: Record<string, ClassifierOutput & {
      status: {
        ok: boolean;
        source: "model" | "fallback";
        reason?: "error" | "timeout";
        error?: string;
      };
      version: string;
    }>;
  };
}
```

Confidence behavior:

- Default confidence threshold is `0.6`.
- Stock fields from results below the threshold are ignored by aggregation.
- Custom `output` values are still included in `custom_outputs` after validation so callers can inspect what a classifier produced.
- Fallbacks use `confidence: 0`, `status.source: "fallback"`, and include `status.error` when available.

Short-circuit behavior:

- Short-circuiting is declarative and narrow.
- A manifest may declare `short_circuit: { "priority": number, "kinds": [...] }`.
- The pipeline short-circuits only when that classifier emits a matching `handoff.kind` at or above the confidence threshold.
- Lower `priority` runs first among short-circuit gates.
- Built-in `preflight` short-circuits on `final`.
- Built-in `security` short-circuits on `block`.

## Example Route Result

```json
{
  "decision": "route",
  "target_message_hash": "b11d5268",
  "handoff": { "kind": "route", "ack_reply": "I'll investigate." },
  "routing": {
    "specialization": "coding",
    "execution_mode": "tool_assisted",
    "model_tier": "frontier_fast"
  },
  "context": { "status": "sufficient", "include_prior_messages": 2 },
  "tools": { "required": true, "families": ["workspace"] },
  "safety": { "risk_level": "normal", "signals": [] },
  "custom_outputs": [
    {
      "classifier": "memory_retrieval_queries",
      "reason": "The user refers to their saved preferences.",
      "confidence": 0.87,
      "output": { "queries": ["user code review preferences"] }
    }
  ],
  "model_recommendation": {
    "id": "gpt-5.3-codex",
    "params_in_billions": 30,
    "context_window": 500000,
    "input_tokens_cpm": 0.4,
    "cached_tokens_cpm": 0.05,
    "output_tokens_cpm": 2,
    "resolution": {
      "constraints_used": {
        "specialization": "coding",
        "execution_mode": "tool_assisted",
        "tier": "frontier_fast"
      },
      "constraints_dropped": [],
      "confidences": { "routing": 0.9 },
      "fell_back_to_default": false
    }
  },
  "meta": {
    "classifiers": {}
  }
}
```

Short-circuit results look like:

```json
{
  "decision": "short_circuit",
  "kind": "final",
  "reply": "Anytime.",
  "fired_by": "preflight",
  "target_message_hash": "b11d5268",
  "handoff": { "kind": "final", "reply": "Anytime." },
  "meta": {
    "classifiers": {}
  }
}
```

## Model Catalog

Classifiers do not emit model ids. They emit `routing` constraints. The model catalog is the source of truth for concrete downstream models.

```json
{
  "models": [
    {
      "id": "gpt-5.5",
      "specializations": ["chat", "writing", "reasoning", "planning", "coding", "instruction_following"],
      "execution_modes": ["direct", "tool_assisted", "workflow"],
      "tier": "frontier_strong",
      "params_in_billions": 800,
      "context_window": 1000000,
      "input_tokens_cpm": 5,
      "cached_tokens_cpm": 0.5,
      "output_tokens_cpm": 25
    },
    {
      "id": "gpt-5.3-codex",
      "specializations": ["coding"],
      "execution_modes": ["direct", "tool_assisted"],
      "tier": "frontier_fast",
      "params_in_billions": 30,
      "context_window": 500000,
      "input_tokens_cpm": 0.4,
      "cached_tokens_cpm": 0.05,
      "output_tokens_cpm": 2
    },
    {
      "id": "qwen2.5-coder:14b",
      "specializations": ["coding"],
      "execution_modes": ["direct", "tool_assisted"],
      "tier": "local_strong",
      "params_in_billions": 14,
      "context_window": 128000
    }
  ],
  "default": "gpt-5.3-codex"
}
```

Catalog rules:

- `models` is required and must be non-empty.
- `default` is required and must reference an existing model id.
- `specializations` is a non-empty array.
- `execution_modes` is a non-empty array.
- `tier` is singular.
- `params_in_billions` is required and positive.
- `context_window` is required and positive.
- Pricing fields are all-or-none: `input_tokens_cpm`, `cached_tokens_cpm`, and `output_tokens_cpm`.
- Missing pricing means zero external token cost for resolver ranking, which is useful for local models.

Resolver algorithm:

1. Collect confident `routing` constraints from classifier outputs.
2. Treat `execution_mode` as hard.
3. Treat `specialization` and `model_tier` as soft.
4. Try hard constraints plus specialization plus exact tier.
5. If empty, drop tier.
6. If empty, drop specialization and try tier.
7. If empty, use hard constraints only.
8. If still empty, use `default` and mark `fell_back_to_default`.

Candidate ranking within a pass:

1. Lowest price index.
2. Larger `params_in_billions`.
3. Larger `context_window`.
4. Earlier catalog order.

Price index is:

- `0` when CPM fields are absent.
- `input_tokens_cpm + output_tokens_cpm` when pricing is present.
- `cached_tokens_cpm` is validated and returned, but not used in ranking yet.

The model recommendation includes a resolution audit:

```json
{
  "constraints_used": {
    "specialization": "coding",
    "execution_mode": "tool_assisted",
    "tier": "frontier_fast"
  },
  "constraints_dropped": [
    { "axis": "tier", "reason": "no_match_relaxed" }
  ],
  "confidences": { "routing": 0.82 },
  "fell_back_to_default": false
}
```

Drop reasons are:

- `low_confidence`
- `no_match_relaxed`
- `default_fallback`
- `escape_hatch` is retained in the public type for compatibility, but current stock classifier outputs omit uncertain fields instead of emitting escape-hatch values.

## Classifier Manifests

Every classifier directory must contain:

```txt
src/classifiers/<name>/
├── manifest.json
└── prompt.md
```

`output.schema.json` is also supported by the asset copier, but the current loader reads `output_schema` from `manifest.json`.

### Manifest Fields

```json
{
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate short saved-memory query hints for caller-owned memory retrieval.",
  "order": 60,
  "emits": {
    "output": true
  },
  "fallback": {
    "reason": "",
    "confidence": 0,
    "output": {
      "queries": []
    }
  },
  "output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["queries"],
    "properties": {
      "queries": {
        "type": "array",
        "maxItems": 5,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "uniqueItems": true
      }
    }
  },
  "backend": {
    "ollama": {
      "base_model": "gemma4:e4b-it-q4_K_M",
      "adapter_model": "open-classify-memory"
    }
  },
  "ui": {
    "label": "Memory queries",
    "renderer": "object"
  }
}
```

Required manifest fields:

- `name`: runtime classifier id. It should match the directory name.
- `version`: classifier contract version displayed in `meta.classifiers`.
- `purpose`: human-readable description.
- `order`: explicit integer order. Duplicate orders are rejected.
- `emits`: stock fields this classifier is allowed to emit.
- `fallback`: valid fallback output, usually with `confidence: 0`.

Optional manifest fields:

- `short_circuit`: declarative gate config: `{ "priority": number, "kinds": ["final" | "block" | "route"] }`.
- `tool_families`: allowed tool-family ids and descriptions when emitting `tools`.
- `output_schema`: required when `emits.output` is true.
- `backend.ollama.base_model`: base model for this classifier.
- `backend.ollama.adapter_model`: default adapter model for this classifier.
- `ui.label`: display name for the workbench.
- `ui.renderer`: one of `enum`, `list`, `object`, or `boolean`.

Manifest validation rejects:

- unsupported manifest fields
- duplicate classifier names
- duplicate classifier orders
- missing or empty `prompt.md`
- output fields not declared by `emits`
- `emits.output: true` without `output_schema`
- fallback outputs that do not satisfy the manifest
- custom outputs that do not satisfy `output_schema`

### Prompt Files

`prompt.md` is the classifier-specific instruction text. The runner combines the manifest-derived stock output guidance with the classifier prompt when preparing an Ollama call.

Keep prompts focused on classifier behavior:

- what the classifier decides
- when to emit each declared stock field
- when to omit optional fields
- what shape custom `output` must have
- concise examples only when they clarify boundaries

Do not put aggregation rules or model-id routing rules in the prompt. Those belong in the runtime and catalog.

## Adding a Classifier

1. Create a directory:

   ```txt
   src/classifiers/<name>/
   ```

2. Add `manifest.json`.

3. Add `prompt.md`.

4. Decide whether the classifier emits only stock fields or custom `output`.

5. If it emits custom `output`, add `output_schema` to the manifest.

6. Add a fallback output that validates against the manifest.

7. If the classifier emits `tools`, define `tool_families` unless you intentionally want any string family id.

8. If the classifier can short-circuit the pipeline, add a narrow `short_circuit` declaration.

9. Add eval labels in:

   ```txt
   training/eval-labels/<name>.jsonl
   ```

10. Add a labeling spec in:

   ```txt
   training/labeling-specs/<name>.md
   ```

11. Run:

   ```sh
   npm run build-evals
   npm test
   ```

No TypeScript registry edit is required. The runtime discovers classifier manifests, sorts by `order`, validates everything, and builds the registry.

## Training And Evals

Training artifacts live outside `src`.

```txt
training/
├── labeling-specs/<classifier>.md
├── eval-labels/<classifier>.jsonl
├── evals/<classifier>.jsonl
├── training-data/<classifier>.jsonl
└── adapters/<classifier>/
```

- `training/labeling-specs` describes how to generate or curate labels.
- `training/eval-labels` is the source of truth for expected outputs keyed by scenario title.
- `training/evals` is generated by `npm run build-evals`.
- `training/training-data` is user-specific and gitignored.
- `training/adapters` contains trained adapter artifacts and is gitignored except docs.

`npm run build-evals` discovers classifier manifests and validates labels against declared stock fields and custom `output_schema`.

## Ollama Runtime

Open Classify runs all classifiers concurrently through the Ollama runner.

Start Ollama with enough parallelism for the built-ins:

```sh
OLLAMA_NUM_PARALLEL=7 \
OLLAMA_MAX_LOADED_MODELS=7 \
OLLAMA_CONTEXT_LENGTH=4096 \
ollama serve
```

`npm run start` handles this for local development.

Adapter model selection order:

1. Programmatic runner overrides.
2. Local `adapter-models.json`.
3. `backend.ollama.adapter_model` from the manifest.
4. `backend.ollama.base_model` from the manifest.
5. Runtime default base model.

## Local Workbench

```sh
npm run setup
npm run start
```

The workbench opens at `http://127.0.0.1:4317/`.

The UI discovers classifiers from manifests through the runtime metadata endpoint. Classifier cards, labels, order, emitted fields, and field display metadata are not hardcoded in the dashboard.

## Development Checks

```sh
npm test
npm run build-evals
```

`npm test` builds the package, copies classifier assets into `dist`, and runs the test suite.

`npm run build-evals` rebuilds chat-format eval files from shared scenarios and per-classifier labels.
