# Adding a classifier

Every classifier — reserved-field-bearing or pure custom — uses the same two-file layout. There is no separate "stock" vs "custom" distinction; the runtime only cares about which reserved fields a classifier opts into.

There are two places a classifier can live:

- **Inside this repo**, under `src/classifiers/<name>/` — only do this if you're contributing back to Open Classify.
- **Inside your own app**, in any directory you point at via `extraClassifierDirs` — this is the right path when you've installed Open Classify as a dependency. See [Adding classifiers from a consumer project](#adding-classifiers-from-a-consumer-project) below.

Either way, the layout and contract are identical.

## 1. Create the directory

```
<your-classifiers-dir>/<name>/
├── manifest.json
└── prompt.md
```

The directory name must match `manifest.json`'s `name` field. Top-level directories starting with `_` (like `_prompts/`) are reserved for shared assets and skipped by the loader.

## 2. Write the manifest

Minimal example — a pure-custom classifier that emits tags. You don't need to provide JSON examples; the runtime synthesizes one from your schema and shows it to the model.

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

If your classifier's behavior is nuanced enough that hand-picked examples would help the model (preflight is one), add an `output_schema.examples` array. The runtime validates each example against the composed schema at load time, so a broken example fails the build.

To also influence routing, opt into a reserved field:

```json
{
  "name": "topic_tags",
  "version": "1.0.0",
  "purpose": "Tag the message and pick a specialization for the downstream model.",
  "dispatch_order": 70,
  "reserved_fields": ["model_specialization"],
  "output_schema": {
    "required": ["tags"],
    "properties": {
      "tags": { "type": "array", "items": { "type": "string" } }
    }
  },
  "fallback": {
    "reason": "Classifier failed.",
    "certainty": "no_signal",
    "tags": []
  }
}
```

The runtime knows `model_specialization` is a reserved field and injects its canonical enum values into the prompt automatically. You don't paste enum values in your `prompt.md`.

Rules:

- `name` must match the directory name.
- Reserved field names cannot appear in `output_schema.properties`; declare them in `reserved_fields` instead.
- `reason` and `certainty` are added to the composed schema by the runtime — don't declare them.
- `fallback` must validate against the composed schema. Only `reason` and `certainty` are required in fallback; reserved fields and `output_schema.required` fields are exempt (a "no signal" fallback usually omits them).
- `output_schema.examples` (JSON Schema standard) must validate against the composed schema at load time, so a broken example fails the build, not the model call.

See [manifests.md](manifests.md) for the full field list.

## 3. Write the prompt

`prompt.md` is the classifier-specific instruction text. The runtime composes it with auto-generated sections describing the JSON contract and the reserved fields you opted into, so your prompt can focus on the classification rule:

```markdown
You are the topic_tags classifier.

`tags` are short single-word topic labels (lowercase, no spaces). Use at most five.
Return an empty array when no clear topic applies.
Do not invent tags for vague or ambiguous messages.
```

Don't paste enum values for reserved fields — the runtime injects them with canonical wording so they never drift from `src/enums.ts`.

## 4. Build and test

If your classifier lives inside this repo:

```sh
npm run build   # validates the manifest, composes the schema, copies assets
npm test
```

If the manifest is malformed, the loader throws `ClassifierManifestError` with the path and a specific reason.

If your classifier lives in a consumer project, validation runs the moment you call `createClassifier({ extraClassifierDirs: [...] })` — the same `ClassifierManifestError` will surface there.

## Adding classifiers from a consumer project

If you've installed Open Classify as an npm dependency, **do not** add classifiers under `node_modules/open-classify/` — every `npm install`/`npm update` rebuilds `node_modules` from package contents and wipes them.

Instead, keep your custom classifiers inside your own project tree and pass their parent directory (or directories) to `createClassifier`:

```
my-app/
├── classifiers/
│   ├── topic_tags/
│   │   ├── manifest.json
│   │   └── prompt.md
│   └── intent/
│       ├── manifest.json
│       └── prompt.md
└── src/
    └── index.ts
```

```ts
import { createClassifier } from "open-classify";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const { classify, registry } = createClassifier({
  extraClassifierDirs: [resolve(here, "../classifiers")],
});

console.log(registry.names);
// → [ "preflight", "model_tier", ..., "topic_tags", "intent" ]
```

Rules:

- `extraClassifierDirs` accepts one or more directories; each is scanned the same way as the bundled built-ins (one folder per classifier).
- Folder layout, manifest contract, and validation are identical to in-repo classifiers — see steps 1–3 above.
- **Name collisions throw.** If any extra classifier shares a `name` with a built-in (or with another extra), `buildClassifierRegistry` raises `ClassifierManifestError` at startup. This is intentional: silent overrides would break the moment a future package update introduced a new built-in with the same name. Pick a unique name (or namespace yours, e.g. `myapp_intent`).
- Use absolute paths (e.g. via `path.resolve(...)` or `fileURLToPath(import.meta.url)`); relative paths are resolved against the process working directory.
- The introspection bundle returned on `createClassifier()` (`{ registry, classify, inspect }`) lets you iterate `registry.names` or pull manifests off `registry.modulesByName` for diagnostics.

Updating Open Classify (`npm update open-classify`) only touches `node_modules`, so anything under your project's classifiers folder is left alone.

## 5. Consume the output

```ts
const { classify } = createClassifier({ catalog });
const result = await classify(input);
const tags = result.classifier_outputs.topic_tags?.tags ?? [];
```

`classifier_outputs[name]` includes all payload fields plus `reason` (string) and `certainty` (float).

## Targeting the assistant response

Classifiers run against the user message by default. To run a classifier against the assistant's reply instead (or in addition), set `applies_to` in the manifest:

- `"user"` (default) — only `classify()` runs it.
- `"assistant"` — only `inspect()` runs it.
- `"both"` — both passes run it.

Use `inspect()` from `createClassifier()` for the assistant-side pass. It returns a lean shape: `target_message_hash`, the `message` that was inspected, and `classifier_outputs`. No routing, no action, no block logic.

```ts
const { inspect } = createClassifier({ catalog });
const post = await inspect({
  messages: [
    { role: "user", text: "Summarize the contract." },
    { role: "assistant", text: "The contract has three notable risks…" },
  ],
});
const risk = post.classifier_outputs.prompt_injection?.risk_level;
```

The built-in `prompt_injection` ships tagged `"both"` so it runs on both sides.

## Choosing the classifier model

For apps and OSS installs, prefer `open-classify.config.json`:

```json
{
  "runner": {
    "provider": "ollama",
    "defaultModel": "gemma4:e4b-it-q4_K_M",
    "models": {
      "topic_tags": "qwen2.5:7b-instruct-q4_K_M"
    }
  }
}
```

`runner.defaultModel` applies to every classifier without an override. `runner.models` is a flat map keyed by classifier name — there is no separate stock/custom split.

Classifier manifests may also carry an Ollama hint for packaged classifiers:

```json
{
  "backend": { "ollama": { "base_model": "qwen2.5:7b-instruct-q4_K_M" } }
}
```

Config file and function options take precedence over manifest hints.

## Replacing the backend

For full backend control, implement your own `RunClassifier` and pass it to `classifyOpenClassifyInput`:

```ts
import { classifyOpenClassifyInput, loadCatalog } from "open-classify";

const runClassifier: RunClassifier = async (name, input, signal) => {
  // call OpenAI, Anthropic, a remote service, etc.
  // return a ClassifierOutput matching the classifier's composed schema.
};

await classifyOpenClassifyInput(input, { runClassifier, catalog: loadCatalog(...) });
```
