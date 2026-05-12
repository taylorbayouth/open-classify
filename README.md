<p align="center">
  <img src="open-classify-logo.png" alt="Open Classify" width="220">
</p>

<p align="center">
  Decide what should happen to a user message <em>before</em> it reaches your downstream model.
</p>

Open Classify runs a small set of fast classifiers in parallel against the latest user message and tells your app one of four things: **route** it (and to which model), **answer** it immediately, **block** it, or flag it for **review**.

```
                ┌──────────────┐
                │  preflight   │ ─► final_reply? ack_reply?
                ├──────────────┤
                │  routing     │ ─► model_tier?
   message ──►  │  model_spec  │ ─► specialization?      ──►  aggregator ──►  { action, model_id?, ... }
                │  tools       │ ─► tools?
                │  security    │ ─► safety verdict
                ├──────────────┤
                │  …custom…    │ ─► your own JSON-Schema output
                └──────────────┘
                 (run in parallel)
```

Stock classifiers have fixed typed signals. Custom classifiers carry their own JSON-Schema-validated payload. The aggregator merges everything, resolves a concrete model from your catalog, and short-circuits when preflight has a final answer or security flags risk.

## Install

```sh
npm install open-classify
```

Node 18+. The reference runner is local Ollama and ships with `gemma4:e4b-it-q4_K_M` as the zero-config classifier model, but `RunClassifier` is a single function — bring your own backend.

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
  { catalog: loadCatalog("downstream-models.json") },
);

if (result.action === "route") {
  // result.downstream.model_id is a concrete model from your catalog.
  // result.downstream.tools is the recommended tool exposure.
  // result.classifier_outputs holds any custom classifier payloads.
}
```

## What you get back

Every call returns a `PipelineResult` with one of four `action` values:

| `action` | When | Key fields |
|---|---|---|
| `route` | Default — downstream work should continue | `downstream.{model_id, messages, target_message, tools, attachments}` |
| `answer` | Preflight had a tiny terminal reply (`final_reply`) | `reply` |
| `block` | Security flagged `decision: "block"` (with `high_risk`) | `reason.{risk_level, signals}` |
| `needs_review` | Security flagged `decision: "needs_review"` | `reason.{risk_level, signals}` |

All four also carry `message_id`, `classifier_outputs` (custom classifier payloads, keyed by name), and an `audit` block. Route results include the full envelope and per-classifier metadata; short-circuit results include the firing classifier's audit context.

Example `route` result:

```json
{
  "action": "route",
  "message_id": "b11d5268",
  "downstream": {
    "model_id": "gpt-5.3-codex",
    "tools": { "tools": ["workspace"] },
    "messages": [ /* normalized conversation */ ],
    "target_message": { "role": "user", "text": "...", "hash": "b11d5268" },
    "attachments": []
  },
  "classifier_outputs": {
    "memory_retrieval_queries": { "queries": ["user code review preferences"] }
  },
  "audit": { "routing": { "model_tier": "frontier_fast", "specialization": "coding" }, "...": "..." }
}
```

## Stock classifiers

Stock classifiers are built in and have fixed, typed output shapes. Each one owns exactly one signal. Its manifest lives in `src/classifiers/stock/<name>/manifest.json`; the shared stock prompt building blocks live in `src/classifiers/stock/prompts/`.

| Name | Signal | Short-circuits? |
|---|---|---|
| `preflight` | `final_reply?` / `ack_reply?` | `final_reply` → `answer` |
| `routing` | `model_tier?` | no |
| `model_specialization` | `specialization?` | no |
| `tools` | `{ tools[] }` | no |
| `security` | `{ decision?, risk_level, signals[] }` | `decision: "block"` → `block`, `"needs_review"` → `needs_review` |

Each output may also carry optional `reason` (≤120 chars) and `confidence` (0–1). Below-threshold signals are dropped from aggregation; the default threshold is `0.6`.

## Custom classifiers

A custom classifier is two files in `src/classifiers/custom/<name>/`:

`manifest.json`:

```json
{
  "kind": "custom",
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate saved-memory query hints.",
  "order": 60,
  "fallback": { "output": { "queries": [] } },
  "output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["queries"],
    "properties": {
      "queries": {
        "type": "array", "maxItems": 5,
        "items": { "type": "string", "minLength": 1, "maxLength": 120 }
      }
    }
  }
}
```

`prompt.md`: your classifier-specific instructions.

The runtime auto-discovers it, validates outputs against your schema, and surfaces them on `result.classifier_outputs.<name>`. No TypeScript edits required.

See [docs/adding-a-classifier.md](docs/adding-a-classifier.md) for a full walkthrough.

## Model catalog

Classifiers never emit model ids. They emit constraints; your catalog maps constraints to concrete models.

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

The resolver picks the cheapest model matching `specialization` and `tier`, relaxing constraints in order when nothing fits, and reports what it dropped on `audit.model_recommendation.resolution`. See [docs/resolver.md](docs/resolver.md) for ranking details.

## Input contract

`classifyWithOllama({ messages, attachments? })` — that's the whole input.

- `messages` is chronological, oldest to newest, and must end with the user message you want classified.
- Open Classify keeps whole messages only, drops oldest first to fit a 5,000-char budget, and caps history at 20 messages.
- `attachments` is metadata only: `filename`, `mime_type`, `size_bytes`. Open Classify never sees file contents.
- Unknown fields are rejected, not passed through.

## Local workbench

```sh
npm run setup
npm run start
```

UI opens at `http://127.0.0.1:4317/`. Classifier cards use classifier names from the runtime, displayed with underscores as spaces; result rendering remains generic.

Optional runtime config:

```sh
cp open-classify.config.example.json open-classify.config.json
```

```json
{
  "runner": {
    "provider": "ollama",
    "defaultModel": "gemma4:e4b-it-q4_K_M",
    "models": {
      "stock": {
        "routing": "qwen2.5:7b-instruct-q4_K_M",
        "security": "llama-guard3:8b"
      },
      "custom": {
        "memory_retrieval_queries": "qwen2.5:7b-instruct-q4_K_M"
      }
    }
  },
  "catalog": "downstream-models.json"
}
```

`runner.defaultModel` applies to any classifier without an explicit entry. `runner.models.stock` configures built-in classifiers; `runner.models.custom` configures custom classifiers by manifest name. The setup and start scripts read `open-classify.config.json`, or `OPEN_CLASSIFY_CONFIG` when you want a different path.

## Bring your own backend

The Ollama runner is one implementation of a single function:

```ts
type RunClassifier = (
  name: string,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput>;
```

Pass any `RunClassifier` to `classifyOpenClassifyInput(input, { runClassifier, catalog })` to back classifiers with OpenAI, Anthropic, a remote service, or anything else.

## Further reading

- [docs/signals.md](docs/signals.md) — full signal contracts and validation rules
- [docs/manifests.md](docs/manifests.md) — manifest reference (stock and custom)
- [docs/resolver.md](docs/resolver.md) — aggregation and model resolution
- [docs/adding-a-classifier.md](docs/adding-a-classifier.md) — author guide

## Development

```sh
npm test      # build + run the Node test runner suite
npm run ui    # build + serve the local workbench
```
