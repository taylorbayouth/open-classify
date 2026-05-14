# Adding a classifier

Most additions are custom classifiers. You drop two files in a directory; the runtime picks them up. No TypeScript registry edits required.

## 1. Pick a directory

Custom classifier:

```
src/classifiers/custom/<name>/
├── manifest.json
└── prompt.md
```

Stock classifier names are closed (`preflight`, `routing`, `model_specialization`, `tools`, `prompt_injection`). You generally don't add new stock classifiers — extend behavior with a custom one instead.

## 2. Write the manifest

```json
{
  "kind": "custom",
  "name": "topic_tags",
  "version": "1.0.0",
  "purpose": "Tag the message with a small set of topic labels for analytics.",
  "order": 70,
  "fallback": {
    "reason": "Classifier failed; no tags generated.",
    "certainty": "no_signal",
    "output": { "tags": [] }
  },
  "output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["tags"],
    "properties": {
      "tags": {
        "type": "array", "maxItems": 5,
        "items": { "type": "string", "minLength": 1, "maxLength": 40 }
      }
    }
  }
}
```

Rules:

- `name` must match the directory name.
- `name` must not collide with a stock classifier name.
- `order` must not collide with any other classifier.
- `fallback` must validate against your `output_schema`.

See [manifests.md](manifests.md) for the full field list.

## 3. Write the prompt

`prompt.md` is the classifier-specific instruction text. The runtime composes it with an auto-generated preamble that describes the JSON output envelope, so your prompt can focus on the classification rule:

```markdown
You are the topic_tags classifier.

Tags are short single-word topic labels (lowercase, no spaces). Use at most five.
Return an empty array when no clear topic applies.
Do not invent tags for vague or ambiguous messages.
```

Keep it focused. Don't put aggregation or routing rules in prompts — those live in the runtime and catalog.

## 4. Build and test

```sh
npm run build   # validates the manifest, sorts the registry, copies assets
npm test
```

If the manifest is malformed, the loader throws `ClassifierManifestError` with the path and a specific reason.

## 5. Consume the output

```ts
const result = await classifyWithOllama(input, { catalog });
if (result.action === "route") {
  const tags = result.classifier_outputs.topic_tags?.tags ?? [];
}
```

`result.audit.custom_outputs[]` carries the same data with required `reason` and `certainty` metadata if you need to inspect them.

## Choosing the classifier model

For apps and OSS installs, prefer `open-classify.config.json`:

```json
{
  "runner": {
    "provider": "ollama",
    "defaultModel": "gemma4:e4b-it-q4_K_M",
    "models": {
      "custom": {
        "topic_tags": "qwen2.5:7b-instruct-q4_K_M"
      }
    }
  }
}
```

`runner.defaultModel` applies to every classifier without an override. `runner.models.stock` contains built-in classifier ids; `runner.models.custom` contains custom classifier ids.

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
  // return a ClassifierOutput matching the classifier's contract.
};

await classifyOpenClassifyInput(input, { runClassifier, catalog: loadCatalog(...) });
```
