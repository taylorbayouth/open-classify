# Classifiers (mandatory built-ins)

Each subdirectory here is one of the **mandatory** built-in classifiers — `preflight`, `model_tier`, `model_specialization`, `prompt_injection`. The runtime loads every directory in this folder at startup, validates the manifest, composes the system prompt, and registers the classifier with the pipeline. There's no way to turn them off, and extras can't override them.

Directories whose names start with `_` (like `_prompts/`) hold shared assets and are skipped by the loader. Consumers can use the same convention in their own classifier directories to deactivate a classifier without deleting it (`my_classifier/` ↔ `_my_classifier/`).

The other four bundled classifiers — `tools`, `memory_retrieval_queries`, `conversation_digest`, `context_shift` — live in `/templates/` at the package root, not here. They aren't loaded by the runtime; `npx open-classify init` copies them into the consumer's project as `_<name>/` (inactive) so they can be edited and activated locally.

> **Adding a classifier from a consumer project?** Don't put it here — `node_modules/open-classify/` is rebuilt on every `npm install`/`npm update` and your work would be wiped. Keep your classifiers in your own project tree (typically `./classifiers/`, scaffolded by `npx open-classify init`). See [docs/adding-a-classifier.md](../../docs/adding-a-classifier.md) for the consumer flow.

## Creating a new classifier

A classifier is two files in a directory named after it:

```
src/classifiers/<name>/
├── manifest.json
└── prompt.md
```

### `manifest.json`

Minimum required fields are `name`, `version`, `purpose`, and `fallback`. Everything else is optional.

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
        "type": "array",
        "maxItems": 5,
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

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must match the directory name |
| `version` | yes | Contract version string for this classifier |
| `purpose` | yes | One sentence. The runtime tells the LLM to treat it as a hard scope boundary |
| `dispatch_order` | no | Lower runs first; ties run adjacent. Omit to schedule this classifier last |
| `applies_to` | no | `"user"` (default), `"assistant"`, or `"both"`. Controls whether the classifier runs in `classify()`, `inspect()`, or both passes |
| `reserved_fields` | no | Array of well-known output keys (see below) |
| `allowed_tools` | conditional | Required if `reserved_fields` includes `"tools"` |
| `output_schema` | no | JSON Schema for your custom (non-reserved) properties. Omit if you only emit reserved fields |
| `output_schema.examples` | no | Open Classify will synthesize a JSON example from your schema; only provide examples if you want richer ones |
| `fallback` | yes | Returned when the classifier errors or times out. Must validate against the composed schema; reserved fields are optional in fallback |
| `backend.ollama.base_model` | no | Per-classifier Ollama model hint; user config and function options win over this |

### `prompt.md`

Describe in plain language what the classifier should decide and what each output key means. Keep it focused on classification behavior — when to emit each field, when to omit, when to abstain.

```markdown
You are the topic_tags classifier.

`tags` are short single-word topic labels (lowercase, no spaces). Use at most five.
Return an empty `tags` array when no clear topic applies.
Do not invent tags for vague or ambiguous messages.
```

**You do not need to write JSON examples.** Open Classify reads your `output_schema` and the reserved fields you declared, then injects:

- The shared JSON-only contract (return one JSON object, etc.)
- The `reason` and `certainty` rules
- The classifier header with your `name` and `purpose`
- A canonical prompt fragment for each declared reserved field, including the exact enum values the LLM may emit
- A synthesized JSON example of a complete output, derived from your schema

If your classifier's behavior is nuanced enough that a few hand-picked examples would teach the model better than a synthesized skeleton (preflight is one), add an `output_schema.examples` array. The runtime validates each example against the composed schema at load time, so a broken example fails the build, not the model call.

## Reserved fields

A reserved field is a well-known output key the aggregator knows how to consume. Declare them in your manifest's `reserved_fields` array; the runtime injects the canonical sub-schema and prompt fragment automatically. You never paste enum values for these — they can't drift from `src/enums.ts`.

| Reserved field | Shape | What the aggregator does with it |
|---|---|---|
| `final_reply` | `{ text: string ≤200 chars }` | Sets `result.action = "reply"` and `result.reply` |
| `ack_reply` | `{ text: string ≤200 chars }` | Sets `result.reply` (when action is `"route"`) |
| `model_tier` | enum (`local_fast`, `local_strong`, `frontier_strong`, …) | Soft constraint for the catalog resolver |
| `model_specialization` | enum (`chat`, `coding`, `reasoning`, …) | Soft constraint for the catalog resolver |
| `tools` | array of allowed tool ids | Sets `result.tools`. Requires `allowed_tools` on the manifest |
| `risk_level` | enum (`normal`, `suspicious`, `high_risk`, `unknown`) | Sets `result.prompt_injection`; high_risk/unknown → `action: "block"` |

When multiple classifiers emit the same reserved field, the aggregator picks the highest-certainty contributor. Ties are broken by manifest `dispatch_order` ascending (first wins).

`final_reply` and `ack_reply` are mutually exclusive — a single output may contain at most one.

## What gets composed into the system prompt

For a manifest with `reserved_fields: ["model_tier"]` and a custom `tags: string[]` property, the runtime builds a prompt that looks roughly like:

```
Return one JSON object and no other text.

Always include:
- reason: required highly compressed justification, 120 characters or fewer
- certainty: required. Use one of "no_signal", ..., "near_certain".

Classifier: topic_tags
Purpose: ...
Treat the stated purpose as a hard scope boundary.

Reserved fields you may emit at the top level of your JSON output:
- `model_tier`: one of "local_fast", "local_small", ..., "frontier_coding".
  Use local tiers for short, low-stakes, or self-contained requests.
  ...

Classifier guidance:
<your prompt.md content>

Output shape (return one JSON object matching this shape):
Example 1: {"reason":"<short reason for this verdict>","certainty":"strong","model_tier":"local_fast","tags":["<text>"]}
```

So your `prompt.md` only has to cover the parts that aren't already in the schema or the reserved-field registry — typically just the decision rule and when to abstain.

## Which pass runs the classifier (`applies_to`)

`classify()` is the user-input pass — it routes a user message to a downstream model. `inspect()` is the assistant-output pass — a lean post-hoc pass over the model's reply (no routing, no action, no block logic).

| `applies_to` | `classify()` | `inspect()` |
|---|---|---|
| `"user"` (default) | runs | skipped |
| `"assistant"` | skipped | runs |
| `"both"` | runs | runs |

Of the built-ins, only `prompt_injection` is tagged `"both"`. Everything else is `"user"` by default. When you tag a classifier `"both"`, write `prompt.md` so it makes sense for whichever role the input declares — the runtime injects a one-line role note into the prompt automatically.

## Validation

The loader rejects manifests that:

- declare a reserved field name in `output_schema.properties`
- declare `reason` or `certainty` in `output_schema.properties`
- list `allowed_tools` without `tools` in `reserved_fields` (or vice versa)
- have a `fallback` that doesn't validate against the composed schema
- have an `output_schema.examples[]` entry that doesn't validate against the composed schema
- have an empty `prompt.md`
- have a `name` that doesn't match the parent directory

## Build + test

```sh
npm run build    # validates every manifest and composes its schema + prompt
npm test
```

If anything in your manifest is wrong, the loader throws `ClassifierManifestError` with the path and a specific reason.
