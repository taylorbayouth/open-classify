<p align="center">
  <img src="open-classify-logo.png" alt="Open Classify" width="220">
</p>

<p align="center">
  Decide what should happen to a user message <em>before</em> it reaches your downstream model.
</p>

Open Classify is a manifest-driven classifier runtime for AI apps that need a fast decision layer in front of generation.

Instead of asking one large downstream model to do everything at once, Open Classify runs a small set of focused classifiers in parallel against the latest user message, then tells your app one of four things:

- `route` the message to a concrete downstream model
- `answer` it immediately with a tiny terminal reply
- `block` it
- flag it as `needs_review`

That separation is the point.

- Routing stays explicit and auditable instead of being hidden inside one giant system prompt.
- Security decisions happen before tool execution or expensive generation.
- Tool exposure is recommended up front instead of inferred ad hoc later.
- Custom classification logic lives in manifests and prompts, not hand-wired TypeScript registries.
- Model choice stays portable because classifiers emit constraints, not provider-specific model ids.

```
                ┌──────────────┐
                │  preflight   │ ─► final_reply? ack_reply?
                ├──────────────┤
                │  routing     │ ─► model_tier? specialization?
   message ──►  │  model_spec  │ ─► model_tier? specialization? ──► aggregator ──► { action, model_id?, ... }
                │  tools       │ ─► tools?
                │  security    │ ─► safety verdict
                ├──────────────┤
                │  …custom…    │ ─► your own JSON-Schema output
                └──────────────┘
                 (run in parallel)
```

Stock classifiers have fixed typed signals. Custom classifiers carry their own JSON-Schema-validated payload. The aggregator merges stock signals, resolves a concrete model from your catalog, and short-circuits when preflight has a final answer or security flags risk.

## Install

```sh
npm install open-classify
```

Node 18+ is required.

The reference runner is local Ollama with `gemma4:e4b-it-q4_K_M`, but the core runtime is backend-neutral: you can provide any `RunClassifier` implementation.

## Why this exists

Most AI applications eventually need the same control-plane decisions:

- Is this message trivial enough to answer immediately?
- Is it safe to continue?
- Which model tier should handle it?
- What specialization fits best?
- Which tool categories should even be exposed?
- What app-specific side signals should be produced for the caller?

If all of that stays bundled into one downstream model prompt, three things usually happen:

1. Routing logic becomes opaque and hard to test.
2. Safety logic competes with task completion logic in the same generation.
3. Adding app-specific classification signals turns into glue code and prompt sprawl.

Open Classify keeps those decisions small, typed, parallel, and inspectable.

## Hello World

```ts
import { classifyWithOllama, loadCatalog } from "open-classify";

const result = await classifyWithOllama(
  {
    messages: [
      { role: "user", text: "Can you review the attached contract?" },
    ],
    attachments: [
      { filename: "contract.pdf", mime_type: "application/pdf", size_bytes: 840_123 },
    ],
  },
  {
    catalog: loadCatalog("downstream-models.json"),
  },
);

if (result.action === "route") {
  console.log(result.downstream.model_id);
  console.log(result.downstream.tools.tools);
  console.log(result.classifier_outputs.memory_retrieval_queries);
}
```

## What you get back

Every call returns a `PipelineResult` with one of four `action` values:

| `action` | When it happens | Key fields |
|---|---|---|
| `route` | Normal path: downstream work should continue | `downstream.{model_id, messages, target_message, tools, attachments}` |
| `answer` | `preflight` emitted a confident `final_reply` | `reply` |
| `block` | `security` emitted confident `decision: "block"` | `reason.{risk_level, signals}` |
| `needs_review` | `security` emitted confident `decision: "needs_review"` | `reason.{risk_level, signals}` |

All results include `message_id` and `audit`.

- `route` results also include the full merged envelope, all classifier metadata, and `classifier_outputs` for custom classifiers.
- Short-circuit results include only the firing classifier in `audit.meta.classifiers`, and `classifier_outputs` is empty.

Example `route` result:

```json
{
  "action": "route",
  "message_id": "b11d5268",
  "downstream": {
    "model_id": "gpt-5.3-codex",
    "tools": { "tools": ["workspace"] },
    "messages": [],
    "target_message": { "role": "user", "text": "...", "hash": "b11d5268" },
    "attachments": []
  },
  "classifier_outputs": {
    "memory_retrieval_queries": { "queries": ["user code review preferences"] }
  },
  "audit": {
    "routing": {
      "model_tier": "frontier_fast",
      "specialization": "coding"
    },
    "custom_outputs": [
      {
        "classifier": "memory_retrieval_queries",
        "reason": "Saved user review preferences could improve the response.",
        "confidence": 0.85,
        "output": { "queries": ["user code review preferences"] }
      }
    ]
  }
}
```

## Core strengths

- Parallel by default: all classifiers start together, so routing, tools, safety, and custom signals do not serialize behind each other.
- Strict contracts: manifests, classifier outputs, catalog entries, and input shape are all validated.
- Soft routing, hard resolution: classifiers recommend `tier` and `specialization`; the catalog resolves those constraints to a real model.
- Cheap to extend: most additions are just `manifest.json` + `prompt.md`.
- Fallback-aware: classifier errors and timeouts fall back to per-classifier manifest fallbacks instead of crashing the whole route.
- Auditable output: callers get per-classifier status, confidence, and version metadata on the route path.

## Stock classifiers

Stock classifiers are built in and live in `src/classifiers/stock/<name>/`.

| Name | Main responsibility | Can short-circuit? |
|---|---|---|
| `preflight` | tiny terminal answers or acknowledgement replies | `final_reply` -> `answer` |
| `routing` | routing hints, usually `model_tier` | no |
| `model_specialization` | routing hints, usually `specialization` | no |
| `tools` | downstream tool categories | no |
| `security` | prompt-injection / exfiltration / permission-boundary risk | `block` or `needs_review` |

Each stock output may also carry:

- `reason`: short explanation, 120 chars max
- `confidence`: float from `0.0` to `1.0`

Default confidence threshold: `0.6`.

Signals below threshold are ignored during aggregation. Missing confidence is treated as `0`.

### Routing nuance

`routing` and `model_specialization` both emit the same partial `RoutingSignal` shape:

```ts
{
  model_tier?: ...,
  specialization?: ...
}
```

In practice, `routing` usually owns the tier axis and `model_specialization` usually owns the specialization axis, but either classifier may emit either field. The aggregator picks the highest-confidence confident value per axis.

## Custom classifiers

A custom classifier is just:

```text
src/classifiers/custom/<name>/
├── manifest.json
└── prompt.md
```

Example manifest:

```json
{
  "kind": "custom",
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate short saved-memory query hints for caller-owned memory retrieval.",
  "order": 60,
  "fallback": {
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
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        }
      }
    }
  }
}
```

What the runtime does for you:

- auto-discovers the classifier
- validates the manifest
- validates outputs against `output_schema`
- includes the validated payload on `result.classifier_outputs.<name>` for route results
- includes metadata-rich copies on `result.audit.custom_outputs`

No TypeScript registry edit is required.

See [docs/adding-a-classifier.md](docs/adding-a-classifier.md).

## Model catalog

Classifiers never emit provider-specific model ids. They emit constraints. Your catalog maps those constraints to concrete models.

Example:

```json
{
  "models": [
    {
      "id": "gpt-5.3-codex",
      "specializations": ["coding"],
      "tier": "frontier_fast",
      "params_in_billions": 30,
      "context_window": 500000,
      "input_tokens_cpm": 0.4,
      "cached_tokens_cpm": 0.05,
      "output_tokens_cpm": 2
    }
  ],
  "default": "gpt-5.3-codex"
}
```

Resolution behavior:

1. Try `specialization + tier`
2. Then `specialization` only
3. Then `tier` only
4. Then no constraints

Within a matching set, the resolver prefers:

1. lower price index: `input_tokens_cpm + output_tokens_cpm` or `0` when pricing is absent
2. larger `params_in_billions`
3. larger `context_window`
4. earlier catalog order

The resolution audit reports which constraints were used and which were dropped.

See [docs/resolver.md](docs/resolver.md).

## Input contract

Open Classify takes only this shape:

```ts
{
  messages: Array<{ role?: "user" | "assistant"; text: string }>;
  attachments?: Array<{
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
  }>;
}
```

Important details:

- `messages` must be chronological, oldest to newest.
- The final message is the one being classified and is forced to `role: "user"`.
- Message text is sanitized before classification.
- The runtime keeps whole messages only, drops oldest first, caps retained history at 20 messages, and enforces a 5,000-character conversation text budget.
- Attachments are metadata only. File contents are never read by the runtime.
- Unknown fields are rejected.

## Local workbench

The repo ships with a small local UI for exercising the classifier set.

```sh
npm run setup
npm run start
```

`npm run setup` verifies prerequisites, installs dependencies, confirms the Ollama base model is available, and builds the project.

`npm run start` ensures Ollama is running with the expected local settings, rebuilds, and serves the UI at [http://127.0.0.1:4317/](http://127.0.0.1:4317/).

If you only want to serve the already-built UI, use:

```sh
npm run ui
```

## Bring your own backend

The Ollama runner is one implementation of a single function:

```ts
type RunClassifier = (
  name: string,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput>;
```

You can call the core pipeline directly:

```ts
import { classifyOpenClassifyInput, loadCatalog } from "open-classify";

const result = await classifyOpenClassifyInput(input, {
  runClassifier,
  catalog: loadCatalog("downstream-models.json"),
});
```

That lets you back classifiers with OpenAI, Anthropic, a remote service, or your own infrastructure.

## Further reading

- [docs/signals.md](docs/signals.md) for stock signal contracts
- [docs/manifests.md](docs/manifests.md) for manifest fields and validation rules
- [docs/resolver.md](docs/resolver.md) for aggregation and model resolution
- [docs/adding-a-classifier.md](docs/adding-a-classifier.md) for authoring custom classifiers

## Development

```sh
npm test
npm run ui
```
