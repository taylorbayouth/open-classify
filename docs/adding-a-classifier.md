# Adding a classifier

Every classifier uses the same two-file layout. Drop a folder into a directory listed under `classifiers.dirs` in `open-classify.config.json` (defaults to `./classifiers/` after `npx open-classify init`) and the runtime picks it up on the next start.

## 1. Create the directory

```
classifiers/<name>/
├── manifest.json
└── prompt.md
```

The directory name must match `manifest.json`'s `name` field. Directories starting with `_` are skipped by the loader — that's the deactivation mechanism (`_topic_tags/` is inert; rename to `topic_tags/` to activate).

## 2. Write the manifest

Minimal example — a pure-custom classifier that emits tags. The runtime synthesizes a JSON example from your schema, so you don't need to write one.

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
- **Name collisions throw.** Extras cannot override the mandatory built-ins (`preflight`, `model_tier`, `model_specialization`, `prompt_injection`). To customize one of those, use a custom `RunClassifier` to intercept it (see "Replacing the backend" below).

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

## 4. Use it

After `npx open-classify init`, your `classifiers/` directory already exists and `open-classify.config.json` points at it. Drop your folder there and call `createClassifier()`:

```ts
import { createClassifier } from "open-classify";

const { classify } = createClassifier();

const result = await classify({
  messages: [{ role: "user", text: "Can you review the attached contract?" }],
});

const tags = result.classifier_outputs.topic_tags?.tags ?? [];
```

`classifiers.dirs` entries resolve relative to the config file, so the scaffold keeps working even if your server starts from a different current working directory.

If the manifest is malformed, `createClassifier` throws `ClassifierManifestError` at startup with the path and a specific reason — typos fail loud.

## Enabling or customizing optional stock classifiers

`tools`, `memory_retrieval_queries`, `conversation_digest`, and `context_shift` ship as package-owned optional stock classifiers. Enable one in `open-classify.config.json` if you want package updates to keep improving its prompt:

```json
{
  "classifiers": {
    "stock": {
      "tools": true
    }
  }
}
```

`npx open-classify init` also copies editable templates into your `classifiers/` directory as `_<name>/` — inactive because of the underscore prefix. To customize one, keep the matching `classifiers.stock.<name>` value `false`, edit the copy, then turn it on:

```sh
mv classifiers/_tools classifiers/tools
```

Edit `manifest.json` first if you need to (`tools` in particular ships with an opinionated `allowed_tools` list you'll almost certainly want to tailor). The reverse works on any copied/custom classifier: rename `<name>/` → `_<name>/` to deactivate without deleting.

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

In `open-classify.config.json`:

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

`runner.defaultModel` applies to every classifier without an override. `runner.models` is a flat map keyed by classifier name — works for mandatory base classifiers, optional stock classifiers, and your own.

Classifier manifests may also carry an Ollama hint:

```json
{
  "backend": { "ollama": { "base_model": "qwen2.5:7b-instruct-q4_K_M" } }
}
```

Config file and function options take precedence over manifest hints.

## Replacing the backend

For full backend control — including replacing a mandatory built-in like `preflight` — implement your own `RunClassifier` and pass it to `createClassifier`:

```ts
import { createClassifier, type RunClassifier } from "open-classify";

const runClassifier: RunClassifier = async (name, input, signal) => {
  if (name === "preflight") {
    // call OpenAI / Anthropic / your own logic; return a ClassifierOutput.
  }
  // …handle other classifiers, or delegate to the Ollama runner you imported.
};

const { classify } = createClassifier({ runClassifier });
```
