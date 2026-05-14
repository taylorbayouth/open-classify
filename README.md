<p align="center">
  <img src="https://raw.githubusercontent.com/taylorbayouth/open-classify/main/open-classify-logo.png" alt="Open Classify" width="220">
</p>

<p align="center">
  Decide what should happen to a user message <em>before</em> it reaches your downstream model.
</p>

Open Classify is a pre-routing layer for AI products. It runs a small set of fast classifiers in parallel against the latest user message, then tells your app one of three things: **route** it, **reply** immediately, or **block** it.

Use it when your frontier model should not be the first thing every request touches. Open Classify can handle tiny terminal replies before they hit an expensive model, recommend the right downstream model for the actual task, suggest what tools or context the downstream model should receive, and add a focused prompt-injection pass.

The result is a small, auditable decision envelope your app can act on before spending the big tokens.

```
message
  │
  ▼
normalize + trim classifier context
  │
  ├─► preflight ─────────────► final_reply? / ack_reply?
  ├─► routing ───────────────► model_tier?
  ├─► model_specialization ──► specialization?
  ├─► tools ─────────────────► tools?
  ├─► prompt_injection ─────► risk_level?
  └─► custom classifiers ────► JSON-Schema output
        (run in parallel)
  │
  ▼
aggregator + model catalog
  │
  ▼
route / reply / block
```

Stock classifiers have fixed typed signals. Custom classifiers carry their own JSON-Schema-validated payload. The aggregator merges everything, resolves a concrete model from your catalog, and short-circuits when preflight has a terminal reply or prompt injection is detected.

## Why Open Classify

- **Spend frontier tokens only when they matter.** Simple greetings, thanks, spelling checks, and small arithmetic can return `action: "reply"` with `reply.text` and skip downstream work entirely.
- **Keep the user interface responsive.** For complex work, preflight can return an `ack_reply` while your app routes the request to the real worker.
- **Pick the right model per message.** Classifiers emit soft constraints like tier and specialization; your catalog turns those into a concrete model optimized for cost, capability, and fit.
- **Shape downstream context intentionally.** Built-in and custom classifiers can recommend tools, retrieval queries, summaries, or other context hints without passing the full conversation history back to the caller.
- **Add another defensive layer.** The `prompt_injection` classifier can block instruction override attempts like “forget previous instructions” without treating ordinary tool requests as injection.

## Install

```sh
npm install open-classify
```

Node 18+. The packaged runner is local Ollama and ships with `gemma4:e4b-it-q4_K_M` as the zero-config classifier model. That runner is configurable through `open-classify.config.json`; arbitrary backends are supported in code by implementing `RunClassifier`.

## Hello World

```ts
import { classifyWithOllama, loadCatalog } from "open-classify";

const result = await classifyWithOllama(
  {
    messages: [
      { role: "user", text: "Can you review the attached contract?" },
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

Every call returns a `PipelineResult` with one of three `action` values:

| `action` | When | Key fields |
|---|---|---|
| `route` | Default — downstream work should continue | `downstream.{model_id, target_message, tools}`, `audit.ack_reply?` |
| `reply` | Preflight had a tiny terminal reply | `reply.text` |
| `block` | Prompt injection flagged confident `high_risk` / `unknown`, or the certainty gate fired | `reason.kind` plus prompt-injection or low-certainty details |

All three also carry `message_id`, `classifier_outputs` (custom classifier payloads, keyed by name), and an `audit` block. Route results include the downstream target message, not the caller's message history. Short-circuit results include the firing classifier's audit context.

For complex requests, look for `audit.ack_reply` on `route` results. It is the immediate acknowledgement your UI can show while the downstream model works. For trivial requests, `result.reply.text` is the complete response and no downstream model is needed.

Example `route` result:

```json
{
  "action": "route",
  "message_id": "b11d5268",
  "downstream": {
    "model_id": "gpt-5.5",
    "tools": { "tools": ["workspace"] },
    "target_message": { "role": "user", "text": "...", "hash": "b11d5268" }
  },
  "classifier_outputs": {
    "memory_retrieval_queries": { "queries": ["user code review preferences"] }
  },
  "audit": {
    "ack_reply": { "reply": "Let me check." },
    "routing": { "model_tier": "frontier_strong" },
    "model_specialization": { "specialization": "coding" },
    "tools": { "tools": ["workspace"] },
    "model_recommendation": {
      "id": "gpt-5.5",
      "context_window": 1050000,
      "input_tokens_cpm": 5,
      "cached_tokens_cpm": 0.5,
      "output_tokens_cpm": 30,
      "resolution": { "...": "..." }
    },
    "meta": { "classifiers": { "...": "..." } }
  }
}
```

## Stock classifiers

Stock classifiers are built in and have fixed, typed output shapes. Each one owns exactly one signal. Its manifest lives in `src/classifiers/stock/<name>/manifest.json`; the shared stock prompt building blocks live in `src/classifiers/stock/prompts/`.

Every classifier prompt includes a shared header with its `Classifier` name, `Purpose`, and an instruction to treat that purpose as a hard scope boundary. In practice:

- `routing` chooses only `model_tier`
- `model_specialization` chooses only `specialization`
- `prompt_injection` is only for prompt injection, not harmfulness, authorization, contradiction, feasibility, or freshness checks

| Name | Signal | Short-circuits? |
|---|---|---|
| `preflight` | `final_reply?` / `ack_reply?` | `final_reply` → `reply` |
| `routing` | `model_tier?` | no |
| `model_specialization` | `specialization?` | no |
| `tools` | `{ tools[] }` | no |
| `prompt_injection` | `{ risk_level }` | confident `high_risk` or `unknown` → `block` |

Each output must carry `reason` (≤120 chars) and `certainty` as a number from 0 to 1. The aggregator drops below-threshold signals; the default threshold is `0.65`.

## Custom classifiers

A custom classifier is two files in `src/classifiers/custom/<name>/`:

`manifest.json`:

```json
{
  "kind": "custom",
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate retrieval queries likely to surface helpful user-specific context for the downstream model.",
  "order": 60,
  "fallback": {
    "reason": "Classifier failed; no memory queries generated.",
    "certainty": 0,
    "output": { "queries": [] }
  },
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

Custom classifiers receive the same shared `Classifier` + `Purpose` header and the same scope-boundary instruction, so keep the manifest `purpose` specific and operational.

The runtime auto-discovers it, validates outputs against your schema, and surfaces them on `result.classifier_outputs.<name>`. No TypeScript edits required.

See [docs/adding-a-classifier.md](docs/adding-a-classifier.md) for a full walkthrough.

## Model catalog

Classifiers never emit model ids. They emit constraints; your catalog maps constraints to concrete models.

```json
{
  "models": [
    {
      "id": "gpt-5.5",
      "provider": "openai",
      "runtime": "api",
      "specializations": [
        "chat",
        "writing",
        "reasoning",
        "planning",
        "coding",
        "tool_use"
      ],
      "tier": "frontier_strong",
      "params_in_billions": null,
      "context_window": 1050000,
      "max_output_tokens": 128000,
      "input_tokens_cpm": 5,
      "cached_tokens_cpm": 0.5,
      "output_tokens_cpm": 30
    }
  ],
  "default": "gpt-5.5",
  "pricing_unit": "USD per 1M tokens"
}
```

OpenAI's GPT-5.5 model page lists text and image input, text output, a 1,050,000-token context window, 128,000 max output tokens, and text-token pricing of $5.00 input, $0.50 cached input, and $30.00 output per 1M tokens. OpenAI does not publish parameter counts, so use `null` for `params_in_billions`. See the [GPT-5.5 model details](https://developers.openai.com/api/docs/models/gpt-5.5) for current pricing and capability details.

The resolver picks the cheapest model matching `specialization` and `tier`, relaxing constraints in order when nothing fits, and reports what it dropped on `audit.model_recommendation.resolution`. See [docs/resolver.md](docs/resolver.md) for ranking details.

## Input contract

`classifyWithOllama({ messages })` — that's the whole input.

- `messages` is chronological, oldest to newest, and must end with the user message you want classified.
- Open Classify keeps whole messages only, drops oldest first to fit a 5,000-char budget, and caps history at 20 messages.
- Unknown fields are rejected, not passed through.

## Local workbench

```sh
npm run setup
npm run start
```

UI opens at `http://127.0.0.1:4317/`. Classifier cards use classifier names from the runtime, displayed with underscores as spaces; result rendering remains generic.

Optional Ollama runtime config:

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
        "prompt_injection": "llama-guard3:8b"
      },
      "custom": {
        "memory_retrieval_queries": "qwen2.5:7b-instruct-q4_K_M"
      }
    }
  },
  "aggregator": {
    "certaintyThreshold": 0.65,
    "certaintyGate": "min_score"
  },
  "catalog": "downstream-models.json"
}
```

`runner.provider` currently supports `"ollama"` only. `runner.defaultModel` applies to any classifier without an explicit entry. `runner.models.stock` configures built-in classifiers; `runner.models.custom` configures custom classifiers by manifest name. `aggregator.certaintyGate` can be `"min_score"` (lowest score across all stock and custom classifiers), `"avg_score"`, or `"off"`. The setup and start scripts read `open-classify.config.json`, or `OPEN_CLASSIFY_CONFIG` when you want a different path.

## Bring your own backend

The Ollama runner is one implementation of a single function:

```ts
type RunClassifier = (
  name: string,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput>;
```

Pass any `RunClassifier` to `classifyOpenClassifyInput(input, { runClassifier, catalog })` to back classifiers with OpenAI, Anthropic, a remote service, or anything else. This is a code-level extension point, separate from the Ollama-only config file runner.

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

## Screenshot

![Open Classify local workbench](https://raw.githubusercontent.com/taylorbayouth/open-classify/main/open-classify-screenshot.png)
