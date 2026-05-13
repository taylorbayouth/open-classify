# Manifest reference

Every classifier directory contains a `manifest.json`. Custom classifiers also contain a `prompt.md`. Stock prompt markdown lives in `src/classifiers/stock/prompts/` and is assembled at runtime.

## Layout

```
src/classifiers/
  stock/prompts/              # built-in prompt markdown
    base.md
    confidence.md
    reason.md
    tier.md
    specialty.md
    tools-output.md
    tools.md
  stock/<name>/                # built-in classifier
    manifest.json
  custom/<name>/               # caller-defined classifier
    manifest.json
    prompt.md
```

The `kind` field in the manifest must match the parent directory (`stock` or `custom`). Mismatches are rejected at load time.

## Common fields

| Field | Required | Description |
|---|---|---|
| `kind` | yes | `"stock"` or `"custom"` |
| `name` | yes | Classifier id. Must match the directory name. |
| `version` | yes | Contract version surfaced in `meta.classifiers[name].version`. |
| `purpose` | yes | Human-readable description. |
| `order` | yes | Integer sort key. Duplicate orders are rejected. |
| `fallback` | yes | Output emitted when the classifier errors or times out. Must validate against the kind's output contract. |
| `backend.ollama.base_model` | no | Packaged Ollama model hint for this classifier. User config and function options take precedence. |

## Stock manifests

Stock manifests use a closed set of names (`preflight`, `routing`, `model_specialization`, `tools`, `prompt_injection`). The runtime knows each name's signal type, so there's no `emits` field. Fallbacks must satisfy the signal contract for that name (see [signals.md](signals.md)).

The `tools` classifier additionally takes:

| Field | Required | Description |
|---|---|---|
| `tools` | no | Array of `{ id, description }`. Restricts which tool ids the classifier may emit. |

Example (`src/classifiers/stock/prompt_injection/manifest.json`):

```json
{
  "kind": "stock",
  "name": "prompt_injection",
  "version": "1.0.0",
  "purpose": "Assess whether the target message contains prompt-injection attempts.",
  "order": 50,
  "fallback": { "risk_level": "unknown" }
}
```

## Custom manifests

| Field | Required | Description |
|---|---|---|
| `output_schema` | yes | JSON Schema (Ajv-validated) for the `output` payload. |

Custom classifier names must not collide with any stock classifier name.

Example:

```json
{
  "kind": "custom",
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate saved-memory query hints for caller-owned memory retrieval.",
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

## Prompt files

Stock prompt files live together in `src/classifiers/stock/prompts/`. The runtime assembles shared markdown (`base.md`, `reason.md`, `confidence.md`, `classifier-header.md`) with focused stock sections such as `tier.md`, `specialty.md`, `tools-output.md`, and the stock classifier file (`preflight.md`, `routing.md`, `model_specialization.md`, `tools.md`, or `prompt_injection.md`).

Dynamic prompt sections use small markdown slots. For example, `tools.md` contains `{{allowed_tools}}`, and the runtime renders the allowed tool list from the tools manifest.

Custom `prompt.md` is the classifier-specific instruction text. The runtime composes it with the shared JSON output envelope, so prompts can stay focused on classifier behavior:

- what the classifier decides
- when to emit each declared field
- when to omit optional fields
- short examples only when they clarify a boundary

Do not put aggregation or model-id rules in prompts — those live in the runtime and catalog.

## Validation rejections

The loader rejects manifests that:

- declare unsupported fields
- collide on `name` or `order`
- have an empty custom `prompt.md`
- declare a custom name that matches a stock classifier
- declare `kind` that doesn't match the parent directory
- have a `fallback` that doesn't satisfy the signal or `output_schema`
- are missing `output_schema` on a custom classifier
- declare `tools` on any classifier other than the `tools` stock classifier
