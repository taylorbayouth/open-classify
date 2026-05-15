# Manifest reference

Every classifier lives in `src/classifiers/<name>/` and contains exactly two files:

```
src/classifiers/
  _prompts/                   # shared base markdown (base.md, reason.md, confidence.md)
  <classifier_name>/
    manifest.json
    prompt.md
```

The loader skips any top-level directory whose name starts with `_` (those are shared assets, not classifiers).

## Fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Classifier id. Must match the directory name. |
| `version` | yes | Contract version string for this classifier. |
| `purpose` | yes | Human-readable description of the classifier's job. Treated as a hard scope boundary in the prompt. |
| `dispatch_order` | no | Non-negative integer scheduling priority. Lower runs first. Omit to schedule this classifier last (treated as +Infinity). Duplicate names are rejected; duplicate dispatch_orders are allowed and schedule adjacent. |
| `applies_to` | no | One of `"user"`, `"assistant"`, `"both"`. Controls which pipeline pass the classifier participates in: `classify()` runs `"user"` + `"both"`; `inspect()` runs `"assistant"` + `"both"`. Defaults to `"user"`. |
| `reserved_fields` | no | Array of reserved field names this classifier may emit at the top level of its output. |
| `allowed_tools` | conditional | Required if `reserved_fields` includes `"tools"`; rejected otherwise. Array of `{ id, description }` listing the tool ids the classifier may pick from. |
| `output_schema` | no | JSON Schema (Ajv-validated). Describes only the custom (non-reserved) properties. The runtime composes this with canonical sub-schemas for any declared reserved fields plus `reason` and `certainty`. |
| `output_schema.examples` | no | Array of full example outputs (reserved + custom + `reason` + `certainty`). Validated against the composed schema at load time. Omit it and the runtime synthesizes a JSON skeleton example from the schema. |
| `fallback` | yes | Output emitted when the classifier errors or times out. Must validate against the composed schema; reserved fields are optional in fallback. |
| `backend.ollama.base_model` | no | Packaged Ollama model hint for this classifier. User config and function options take precedence. |

## Reserved fields

Reserved fields are well-known output keys the aggregator knows how to consume. The runtime owns their JSON Schema sub-schemas and prompt fragments — your manifest just opts in.

| Reserved field | Shape | What the aggregator does with it |
|---|---|---|
| `final_reply` | `{ text: string ≤200 chars }` | Sets `result.action = "reply"` and `result.reply`; caller returns it as the terminal reply |
| `ack_reply` | `{ text: string ≤200 chars }` | Sets `result.reply` (when action is `"route"`); caller shows it as an acknowledgement while downstream works |
| `model_tier` | one of `DOWNSTREAM_MODEL_TIER_VALUES` | Soft constraint for catalog resolver |
| `model_specialization` | one of `MODEL_SPECIALIZATION_VALUES` | Soft constraint for catalog resolver |
| `tools` | array of allowed tool ids | Sets `result.tools` |
| `risk_level` | one of `PROMPT_INJECTION_RISK_LEVEL_VALUES` | Surfaced in `result.prompt_injection`; `"high_risk"` or `"unknown"` triggers `action: "block"` |

`final_reply` and `ack_reply` are mutually exclusive — a single output may contain at most one.

When multiple classifiers emit the same reserved field, the highest-certainty contributor wins. Ties are broken by manifest `dispatch_order` ascending (the first encountered in registry order keeps the slot). Classifiers without `dispatch_order` sort last for tie-break purposes too.

## Example: reserved-only manifest

```json
{
  "name": "model_tier",
  "version": "1.0.0",
  "purpose": "Recommend the downstream model tier.",
  "dispatch_order": 20,
  "reserved_fields": ["model_tier"],
  "output_schema": {
    "examples": [
      { "reason": "Simple factual question.", "certainty": "near_certain", "model_tier": "local_fast" },
      { "reason": "Multi-step refactor.", "certainty": "very_strong", "model_tier": "frontier_coding" }
    ]
  },
  "fallback": {
    "reason": "Classifier failed; no routing signal.",
    "certainty": "no_signal"
  }
}
```

The runtime injects the `model_tier` enum and the canonical prompt fragment automatically. Your `prompt.md` only needs to explain the classification rule.

## Example: custom-only manifest

```json
{
  "name": "memory_retrieval_queries",
  "version": "1.0.0",
  "purpose": "Generate retrieval queries likely to surface helpful user-specific context for the downstream model.",
  "dispatch_order": 60,
  "output_schema": {
    "required": ["queries"],
    "properties": {
      "queries": {
        "type": "array", "maxItems": 5,
        "items": { "type": "string", "minLength": 1, "maxLength": 120 },
        "uniqueItems": true
      }
    },
    "examples": [
      {
        "reason": "Saved code-review preferences could improve the response.",
        "certainty": "strong",
        "queries": ["user code review preferences"]
      },
      {
        "reason": "No saved memories likely to help.",
        "certainty": "very_strong",
        "queries": []
      }
    ]
  },
  "fallback": {
    "reason": "Classifier failed; no memory queries generated.",
    "certainty": "no_signal",
    "queries": []
  }
}
```

## Example: hybrid manifest

A manifest may declare both reserved fields and custom properties; they sit alongside each other at the top level of every output.

```json
{
  "name": "task_router",
  "version": "1.0.0",
  "purpose": "Pick the downstream tier and estimate token usage.",
  "dispatch_order": 25,
  "reserved_fields": ["model_tier", "model_specialization"],
  "output_schema": {
    "required": ["estimated_tokens"],
    "properties": {
      "estimated_tokens": { "type": "integer", "minimum": 0 }
    },
    "examples": [
      {
        "reason": "Code refactor needs reasoning.",
        "certainty": "very_strong",
        "model_tier": "frontier_strong",
        "model_specialization": "coding",
        "estimated_tokens": 12000
      }
    ]
  },
  "fallback": {
    "reason": "Classifier failed.",
    "certainty": "no_signal",
    "estimated_tokens": 0
  }
}
```

## Prompt files

`prompt.md` is the classifier-specific instruction text. The runtime composes the system prompt at load time from:

1. Shared base sections (JSON-only contract, `reason` + `certainty` rules) from `src/classifiers/_prompts/`
2. The classifier header (name and purpose, with the purpose stated as a hard scope boundary)
3. Auto-injected fragments for each declared reserved field (canonical enum values included, so you can't drift)
4. Your `prompt.md`
5. A JSON example of a complete output: the `output_schema.examples` if you provided any, otherwise a synthesized skeleton derived from the schema

Keep `prompt.md` focused on classification behavior — when to emit each field, when to omit, when to abstain. Don't paste enum values for reserved fields; the runtime does that for you.

## Validation rejections

The loader rejects manifests that:

- declare unsupported fields at the manifest root
- collide with another classifier on `name`
- include a reserved field name in `output_schema.properties`
- include `reason` or `certainty` in `output_schema.properties`
- list `allowed_tools` without `tools` in `reserved_fields` (or vice versa)
- have a `fallback` that doesn't validate against the composed schema
- have an `output_schema.examples[]` entry that doesn't validate against the composed schema
- have an empty `prompt.md`
- have a `name` that doesn't match the parent directory
