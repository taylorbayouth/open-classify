# Manifest reference

Every classifier directory contains a `manifest.json` and a `prompt.md`. The runtime auto-discovers manifests, sorts by `order`, validates everything, and rejects duplicates.

## Layout

```
src/classifiers/
  stock/<name>/                # built-in classifier
    manifest.json
    prompt.md
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
| `backend.ollama.base_model` | no | Override the default base model for this classifier. |
| `ui.label` | no | Display label for the workbench. |
| `ui.renderer` | no | One of `enum`, `list`, `object`, `boolean`. |

## Stock manifests

Stock manifests use a closed set of names (`preflight`, `routing`, `model_specialization`, `tools`, `security`). The runtime knows each name's signal type, so there's no `emits` field. Fallbacks must satisfy the signal contract for that name (see [signals.md](signals.md)).

The `tools` classifier additionally takes:

| Field | Required | Description |
|---|---|---|
| `tools` | no | Array of `{ id, description }`. Restricts which tool ids the classifier may emit. |

Example (`src/classifiers/stock/security/manifest.json`):

```json
{
  "kind": "stock",
  "name": "security",
  "version": "1.0.0",
  "purpose": "Assess prompt injection, exfiltration, and permission boundary risk.",
  "order": 50,
  "fallback": { "decision": "needs_review", "risk_level": "unknown", "signals": [] }
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

`prompt.md` is the classifier-specific instruction text. The runtime composes it with a small auto-generated preamble describing the output shape, so prompts can stay focused on classifier behavior:

- what the classifier decides
- when to emit each declared field
- when to omit optional fields
- short examples only when they clarify a boundary

Do not put aggregation or model-id rules in prompts — those live in the runtime and catalog.

## Validation rejections

The loader rejects manifests that:

- declare unsupported fields
- collide on `name` or `order`
- have an empty `prompt.md`
- declare a custom name that matches a stock classifier
- declare `kind` that doesn't match the parent directory
- have a `fallback` that doesn't satisfy the signal or `output_schema`
- are missing `output_schema` on a custom classifier
- declare `tools` on any classifier other than the `tools` stock classifier
