<p align="center">
  <img src="https://raw.githubusercontent.com/taylorbayouth/open-classify/main/open-classify-logo.png" alt="Open Classify" width="220">
</p>

<p align="center">
  Decide what should happen to a user message <em>before</em> it reaches your downstream model.
</p>

Open Classify is a pre-routing layer for AI products. It runs a small set of fast classifiers in parallel against the latest user message, then returns a single `PipelineResult` your app can act on: an action (`route`, `block`, or `reply`), a downstream model recommendation, a tool exposure list, an optional immediate reply, and any custom signals your own classifiers contribute.

Use it when your frontier model should not be the first thing every request touches. Open Classify can handle tiny terminal replies before they hit an expensive model, recommend the right downstream model for the actual task, suggest what tools or context the downstream model should receive, and add a focused prompt-injection pass.

```
message
  │
  ▼
normalize + trim classifier context
  │
  ├─► preflight ─────────────► final_reply? / ack_reply?
  ├─► model_tier ────────────► model_tier?
  ├─► model_specialization ──► model_specialization?
  ├─► prompt_injection ─────► risk_level?
  └─► your own classifiers ──► any JSON-Schema-validated payload
        (all run in parallel, capped by maxConcurrency)
  │
  ▼
aggregator + model catalog
  │
  ▼
PipelineResult { action, model_id, tools, reply, ... }
```

Every classifier uses the same manifest shape and emits the same output envelope: `{ reason, certainty, ...payload }`. Some payload fields are **reserved** — like `model_tier`, `final_reply`, and `risk_level` — and the aggregator knows how to consume them into a routing decision. Everything else is your classifier's own data and passes through to the caller untouched.

## Why Open Classify

- **Spend frontier tokens only when they matter.** Simple greetings, thanks, spelling checks, and small arithmetic can be answered immediately (`action: "reply"`) without sending the request downstream.
- **Keep the user interface responsive.** For complex work, preflight emits an `ack_reply` — a task-specific acknowledgement your UI can show while routing the real request.
- **Pick the right model per message.** Classifiers emit soft constraints like tier and specialization; your catalog turns those into a concrete model optimized for cost, capability, and fit.
- **Shape downstream context intentionally.** Built-in and custom classifiers can recommend tools, retrieval queries, summaries, or other context hints without passing the full conversation history back to the caller.
- **Add another defensive layer.** The `prompt_injection` classifier surfaces instruction-override attempts. High-risk or unknown injection risk automatically sets `action: "block"`.

## Getting started

Prerequisites: Node 18+, [Ollama](https://ollama.com), and the default classifier model:

```sh
ollama pull gemma4:e4b-it-q4_K_M
```

**1. Install**

```sh
npm install open-classify
```

**2. Scaffold**

```sh
npx open-classify init
```

This creates a single `open-classify/` directory in your project root with the config, model catalog, and a place for your own classifiers. Verify the setup at any time with `npx open-classify doctor`.

**3. Use it**

```ts
import { createClassifier } from "open-classify";

const { classify } = createClassifier();

const result = await classify({
  messages: [{ role: "user", text: "Can you review the attached contract?" }],
});

if (result.action === "reply") respondToUser(result.reply.text);          // preflight answered it
else if (result.action === "block") handleBlock(result.block_reason);     // injection or error
else callDownstream(result.model_id, result.tools, result.reply?.text);   // route the real request
```

`createClassifier()` finds `open-classify/config.json` in the working directory — no other wiring required.

## Removal

```sh
rm -rf open-classify/
npm uninstall open-classify
```

That's it. The scaffold lives in one folder; removing it leaves no trace.

## Optional stock classifiers

Open Classify ships four optional stock classifiers: `tools`, `memory_retrieval_queries`, `conversation_digest`, `context_shift`. They're off by default. Enable one in `open-classify/config.json`:

```json
{
  "classifiers": {
    "dirs": ["classifiers"],
    "stock": ["tools"]
  }
}
```

The package-owned prompt is used, and `npm update open-classify` keeps it current.

When you want to take a stock classifier over and edit its prompt:

```sh
npx open-classify eject tools
```

That copies the stock files into `open-classify/classifiers/tools/`. You own them from then on — `npm update` won't touch them. To revert, delete the folder; the stock version takes over again.

## Writing your own classifier

Drop a folder into `open-classify/classifiers/` with two files:

```
open-classify/classifiers/topic_tags/
├── manifest.json
└── prompt.md
```

The folder name must match the manifest's `name`. The runtime picks it up on the next start. See [docs/adding-a-classifier.md](docs/adding-a-classifier.md) for the full reference.

### Classifying assistant output

`inspect()` is a lean second pass for the **assistant's reply**. It only runs classifiers tagged `applies_to: "both"` (or `"assistant"`) in their manifest, and returns the per-classifier outputs plus the message that was inspected — no routing, no action, no block logic.

```ts
const result = await inspect({
  messages: [
    { role: "user", text: "Summarize the contract." },
    { role: "assistant", text: "The contract has three notable risks…" },
  ],
});

// result.message is { role: "assistant", text: "..." }
const risk = result.classifier_outputs.prompt_injection?.risk_level;
```

Use it for things like prompt-injection checks on model output, summarized slugs, or any classifier you want to apply post-hoc. The built-in `prompt_injection` classifier ships tagged `"both"`, so it runs in both passes; everything else is `"user"` by default.

## What you get back

Every `classify()` call returns a `PipelineResult`:

| Field | What it is |
|---|---|
| `action` | `"route"` \| `"block"` \| `"reply"` |
| `block_reason` | `"prompt_injection"` \| `"classification_error"` (only when `action === "block"`) |
| `target_message_hash` | Stable 8-hex fingerprint of the target message |
| `model_id` | Concrete model id chosen from your catalog (or `null` if unresolvable) |
| `tools` | Recommended tool ids (always an array; empty if not emitted) |
| `reply` | `{ text }` — the `ack_reply` or `final_reply` text, if any |
| `prompt_injection` | `{ risk_level }` from the injection classifier, or `null` |
| `avg_certainty` | Arithmetic mean certainty score (float 0–1) across all classifiers |
| `min_certainty` | Minimum certainty score (float 0–1) across all classifiers |
| `failed_classifiers` | Names of classifiers that errored or timed out (always present; may be empty) |
| `classifier_outputs` | Each classifier's payload with `reason` (string) and `certainty` (float) |

Example result:

```json
{
  "action": "route",
  "target_message_hash": "b11d5268",
  "model_id": "gpt-5.5",
  "tools": ["workspace"],
  "reply": { "text": "On it — I'll review the contract now." },
  "prompt_injection": { "risk_level": "normal" },
  "avg_certainty": 0.84,
  "min_certainty": 0.75,
  "failed_classifiers": [],
  "classifier_outputs": {
    "model_tier": { "model_tier": "frontier_strong", "reason": "...", "certainty": 0.88 },
    "model_specialization": { "model_specialization": "coding", "reason": "...", "certainty": 0.75 },
    "tools": { "tools": ["workspace"], "reason": "...", "certainty": 0.88 },
    "prompt_injection": { "risk_level": "normal", "reason": "...", "certainty": 0.97 }
  }
}
```

## Classifier model

Open Classify ships four mandatory base classifiers that always run, plus four optional stock classifiers you can enable or eject.

| Name | dispatch_order | Reserved fields | Bundled as | What the aggregator does with it |
|---|---|---|---|---|
| `preflight` | 10 | `final_reply`, `ack_reply` | mandatory | Sets `action: "reply"` or populates `result.reply` |
| `model_tier` | 20 | `model_tier` | mandatory | Feeds the catalog resolver as a soft constraint |
| `model_specialization` | 30 | `model_specialization` | mandatory | Feeds the catalog resolver as a soft constraint |
| `prompt_injection` | 50 | `risk_level` | mandatory | High-risk/unknown → `action: "block"`; suspicious → advisory |
| `tools` | 40 | `tools` | optional stock | Sets `result.tools` |
| `memory_retrieval_queries` | 60 | — | optional stock | Passes through to `classifier_outputs` |
| `conversation_digest` | 70 | — | optional stock | Passes through |
| `context_shift` | 80 | — | optional stock | Passes through |

To customize a mandatory built-in, use a custom `RunClassifier` (see [Bring your own backend](#bring-your-own-backend)).

## Using reserved fields in your own classifier

Any classifier can emit reserved fields. If you write your own `task_router` that emits `model_tier`, the aggregator will fold it into the model resolution alongside the built-in `model_tier` classifier — highest-certainty contributor wins, ties broken by manifest `dispatch_order` ascending.

```json
{
  "name": "task_router",
  "version": "1.0.0",
  "purpose": "Pick the downstream model tier and specialization for code-heavy tasks.",
  "dispatch_order": 25,
  "reserved_fields": ["model_tier", "model_specialization"],
  "fallback": { "reason": "Classifier failed.", "certainty": "no_signal" }
}
```

The runtime injects canonical sub-schemas and prompt fragments for each declared reserved field — the model is told the exact enum values it may emit. You don't paste enum values into `prompt.md`, and you don't have to hand-write a JSON example; the runtime synthesizes one from the schema and shows it to the model.

The available reserved fields are: `final_reply`, `ack_reply`, `model_tier`, `model_specialization`, `tools`, `risk_level`. The `tools` field additionally requires an `allowed_tools` array on the manifest listing the tool ids the classifier may pick from.

## Configuration

`open-classify/config.json` supports:

| Field | What it controls |
|---|---|
| `runner.provider` | Backend. Currently `"ollama"` only. |
| `runner.host` | Ollama host URL. Defaults to `http://127.0.0.1:11434`. |
| `runner.defaultModel` | Classifier model used when there is no per-classifier override. |
| `runner.options` | Ollama generation options: `temperature`, `top_p`, `seed`, `num_ctx`. |
| `runner.models` | Per-classifier model overrides. Flat map keyed by classifier name. |
| `catalog` | Path to the downstream model catalog, relative to `open-classify/`. |
| `classifiers.dirs` | Directories of user-owned classifiers, relative to `open-classify/`. |
| `classifiers.stock` | Array of stock classifiers to enable. Members of `tools`, `memory_retrieval_queries`, `conversation_digest`, `context_shift`. |

## Input contract

`classify({ messages })` — that's the whole input.

- `messages` is chronological, oldest to newest, and must end with the user message you want classified.
- Open Classify keeps whole messages only, drops oldest first to fit a 5,000-char budget, and caps history at 20 messages.
- Unknown fields are rejected, not passed through.

## Bring your own backend

The Ollama runner is one implementation of a single function:

```ts
type RunClassifier = (
  name: string,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput>;
```

Pass any `RunClassifier` to `createClassifier` to back classifiers with OpenAI, Anthropic, a remote service, or anything else. The factory takes care of catalog loading and pipeline wiring; you only own the per-classifier call.

```ts
import { createClassifier, type RunClassifier } from "open-classify";

const runClassifier: RunClassifier = async (name, input, signal) => {
  // call your provider of choice, return a ClassifierOutput
};

const { classify, inspect } = createClassifier({ runClassifier });
```

For the lowest-level entry points, `classifyOpenClassifyInput(input, { runClassifier, catalog, registry })` and `inspectOpenClassifyInput(input, { runClassifier, registry })` skip the factory entirely.

## Model catalog

Classifiers never emit model ids. They emit constraints; your catalog (`open-classify/downstream-models.json`) maps constraints to concrete models.

```json
{
  "models": [
    {
      "id": "gpt-5.5",
      "provider": "openai",
      "runtime": "api",
      "specializations": ["chat", "writing", "reasoning", "planning", "coding", "tool_use"],
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

The resolver picks the cheapest model matching `model_specialization` and `model_tier`, relaxing constraints in order when nothing fits. See [docs/resolver.md](docs/resolver.md) for ranking details.

## Further reading

- [docs/signals.md](docs/signals.md) — reserved field reference
- [docs/manifests.md](docs/manifests.md) — manifest reference
- [docs/resolver.md](docs/resolver.md) — aggregation and model resolution
- [docs/adding-a-classifier.md](docs/adding-a-classifier.md) — author guide

## Contributing

Clone the repo, then `npm run setup` (checks Node/Ollama, pulls the base model, installs and builds) and `npm test` (build + Node test runner). PRs welcome.
