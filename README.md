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
  ├─► tools ─────────────────► tools?
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

## Install

```sh
npm install open-classify
```

Node 18+. The packaged runner is local Ollama and ships with `gemma4:e4b-it-q4_K_M` as the zero-config classifier model. That runner is configurable through `open-classify.config.json`; arbitrary backends are supported in code by implementing `RunClassifier`.

## Hello World

```ts
import { createClassifier } from "open-classify";

const { classify, inspect } = createClassifier();

const result = await classify({
  messages: [
    { role: "user", text: "Can you review the attached contract?" },
  ],
});

if (result.action === "block") {
  // classification error or prompt injection — handle appropriately
  console.error(result.block_reason, result.failed_classifiers);
} else if (result.action === "reply") {
  // preflight can answer this immediately — skip the downstream model
  respondToUser(result.reply.text);
} else {
  // route to the downstream model
  callDownstream(result.model_id, result.tools);
  respondToUser(result.reply?.text); // show the ack while it works
}

const queries = result.classifier_outputs.memory_retrieval_queries?.queries;
```

`createClassifier` builds the runner and loads the model catalog once. Reuse the returned `classify` and `inspect` functions across your app — every call is a plain function invocation, no re-initialization.

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
    "prompt_injection": { "risk_level": "normal", "reason": "...", "certainty": 0.97 },
    "memory_retrieval_queries": { "queries": ["user code review preferences"], "reason": "...", "certainty": 0.75 }
  }
}
```

## Classifier model

Open Classify ships with eight built-in classifiers; all use the same manifest shape. There is no distinction between "stock" and "custom" — the runtime only cares about which **reserved fields** a classifier declares.

Seven are **active by default**. One — `tools` — is **shipped disabled**, because its `allowed_tools` list is highly app-specific and you'll almost certainly want to edit it. To activate `tools`, copy its directory into your own classifiers folder (see [Turning classifiers on and off](#turning-classifiers-on-and-off)).

| Name | dispatch_order | Reserved fields | Default | What the aggregator does with it |
|---|---|---|---|---|
| `preflight` | 10 | `final_reply`, `ack_reply` | on | Sets `action: "reply"` or populates `result.reply` |
| `model_tier` | 20 | `model_tier` | on | Feeds the catalog resolver as a soft constraint |
| `model_specialization` | 30 | `model_specialization` | on | Feeds the catalog resolver as a soft constraint |
| `tools` | 40 | `tools` | **off** | Sets `result.tools` |
| `prompt_injection` | 50 | `risk_level` | on | High-risk/unknown → `action: "block"`; suspicious → advisory |
| `memory_retrieval_queries` | 60 | — | on | Passes through to `classifier_outputs` |
| `conversation_digest` | 70 | — | on | Passes through |
| `context_shift` | 80 | — | on | Passes through |

Reserved fields are well-known output keys with canonical JSON Schemas and prompt fragments baked into the runtime. When you declare one in your manifest, you don't have to redeclare its enum values or shape — the runtime injects them.

## Adding a classifier

If you've installed Open Classify as a dependency, **keep your classifiers inside your own project tree** and point `createClassifier` at the parent directory. Don't put them under `node_modules/open-classify/` — every `npm install`/`npm update` rebuilds `node_modules` from package contents and wipes them.

A classifier is two files in a directory named after it. Here's the full end-to-end setup for a consumer project:

### 1. Lay out the classifier in your project

```
my-app/
├── classifiers/
│   └── topic_tags/
│       ├── manifest.json
│       └── prompt.md
└── src/
    └── classify.ts
```

The directory name (`topic_tags`) must match `manifest.json`'s `name` field.

### 2. Write `manifest.json`

```json
{
  "name": "topic_tags",
  "version": "1.0.0",
  "purpose": "Tag the message with a small set of topic labels for analytics.",
  "dispatch_order": 70,
  "output_schema": {
    "required": ["tags"],
    "properties": {
      "tags": {
        "type": "array", "maxItems": 5,
        "items": { "type": "string", "minLength": 1, "maxLength": 40 }
      }
    }
  },
  "fallback": {
    "reason": "Classifier failed; no tags generated.",
    "certainty": "no_signal",
    "tags": []
  }
}
```

### 3. Write `prompt.md`

Describe the classification rule in plain language. You don't need to write JSON examples — the runtime synthesizes one from your schema — and you don't paste enum values for reserved fields:

```markdown
You are the topic_tags classifier.

`tags` are short single-word topic labels (lowercase, no spaces). Use at most five.
Return an empty array when no clear topic applies.
Do not invent tags for vague or ambiguous messages.
```

### 4. Register the directory and consume the output

Pass an **absolute path** to `extraClassifierDirs`. Resolving via `import.meta.url` (or `__dirname` in CommonJS) keeps it correct no matter where the process is launched from — `"./classifiers"` would silently resolve against `process.cwd()` and break the moment you run from a different directory:

```ts
import { createClassifier } from "open-classify";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const { classify } = createClassifier({
  extraClassifierDirs: [resolve(here, "../classifiers")],
});

const result = await classify({
  messages: [{ role: "user", text: "Can you review the attached contract?" }],
});

const tags = result.classifier_outputs.topic_tags?.tags ?? [];
```

### Rules

- `name` must match the directory name.
- Reserved field names cannot appear in `output_schema.properties` — declare them in `reserved_fields` instead.
- `fallback` requires only `reason` and `certainty`; reserved and custom required fields are exempt from the fallback check.
- If you want hand-picked examples (preflight does this), add an `output_schema.examples` array. Each entry must validate against the composed schema at load time. Otherwise the runtime synthesizes a skeleton example for you.
- **Name collisions with built-ins (or between two extra dirs) throw `ClassifierManifestError` at startup.** Pick a unique name — namespacing yours (e.g. `myapp_topic_tags`) is a safe habit if you want to stay clear of future built-ins.

> Contributing a classifier back to Open Classify itself? Drop it under `src/classifiers/<name>/` in this repo instead — the manifest contract is identical.

See [docs/adding-a-classifier.md](docs/adding-a-classifier.md) for the full walkthrough and [docs/manifests.md](docs/manifests.md) for the field reference.

## Turning classifiers on and off

There's one knob: a `disabled` list. It applies to built-ins and your own classifiers alike.

```json
{
  "classifiers": {
    "disabled": ["conversation_digest", "context_shift"]
  }
}
```

Or programmatically:

```ts
createClassifier({ disabledClassifiers: ["conversation_digest"] });
```

Names that aren't loaded throw at startup, so typos fail loud.

### To enable `tools` (or any default-disabled built-in)

Copy its directory out of the package and into your own classifiers folder:

```sh
cp -r node_modules/open-classify/dist/src/classifiers/tools ./classifiers/
```

Now edit `classifiers/tools/manifest.json` to tailor `allowed_tools` to your app, and tweak `prompt.md` if you like. Because it's loaded as one of your `extraClassifierDirs`, it runs by default.

This is also the supported way to **customize a default-on built-in**: copy `preflight/` into your own dir, edit the prompt, then disable the bundled one. With `"disabled": ["preflight"]` in your config, the bundled `preflight` drops out and your copy takes its place — no name-collision error.

### Watch out

A few built-ins are load-bearing for the routing pipeline:

- Disable `preflight` without providing a replacement that emits `final_reply` or `ack_reply` → every result blocks as `classification_error` (the contract is "you must produce a reply").
- Disable `model_tier` and `model_specialization` together → routing falls back to the catalog's default model on every request, defeating per-message routing.
- Disable `prompt_injection` → no defensive layer against instruction-override attempts.

These are deliberate dependencies, not bugs. Disable with intent.

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

The resolver picks the cheapest model matching `model_specialization` and `model_tier`, relaxing constraints in order when nothing fits. See [docs/resolver.md](docs/resolver.md) for ranking details.

## Input contract

`classify({ messages })` — that's the whole input.

- `messages` is chronological, oldest to newest, and must end with the user message you want classified.
- Open Classify keeps whole messages only, drops oldest first to fit a 5,000-char budget, and caps history at 20 messages.
- Unknown fields are rejected, not passed through.

## Local setup

```sh
npm run setup
```

Checks prerequisites (Node, npm, Ollama), confirms the base model is pulled, installs dependencies, and builds. Idempotent — safe to re-run.

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
      "model_tier": "qwen2.5:7b-instruct-q4_K_M",
      "prompt_injection": "llama-guard3:8b",
      "memory_retrieval_queries": "qwen2.5:7b-instruct-q4_K_M"
    }
  },
  "catalog": "downstream-models.json"
}
```

`runner.provider` currently supports `"ollama"` only. `runner.defaultModel` applies to any classifier without an explicit `runner.models` entry. `runner.models` is a flat map keyed by classifier name.

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

For the lowest-level entry points, `classifyOpenClassifyInput(input, { runClassifier, catalog })` and `inspectOpenClassifyInput(input, { runClassifier })` skip the factory entirely.

## Further reading

- [docs/signals.md](docs/signals.md) — reserved field reference
- [docs/manifests.md](docs/manifests.md) — manifest reference
- [docs/resolver.md](docs/resolver.md) — aggregation and model resolution
- [docs/adding-a-classifier.md](docs/adding-a-classifier.md) — author guide

## Development

```sh
npm test    # build + run the Node test runner suite
```
