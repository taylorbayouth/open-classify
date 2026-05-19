# classifiers/

Drop a folder here per classifier. Each folder needs exactly two files:

- `manifest.json` — declares the output shape, dispatch priority, and a fallback
- `prompt.md` — the classification instructions

The folder name must match the manifest's `name` field. The runtime picks up every classifier here on the next start. Prefix a folder with `_` (e.g. `_my_classifier/`) to disable it without deleting it.

---

## manifest.json field reference

### Required fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique classifier name. Must match the folder name. Cannot shadow a mandatory built-in (`preflight`, `model_tier`, `model_specialization`, `prompt_injection`). |
| `version` | string | Semver string. Informational only. |
| `purpose` | string | One sentence describing what the classifier does. Injected into the system prompt. |
| `fallback` | object | Output used when the classifier errors or times out. Must include `reason` (string) and `certainty` (`"no_signal"` recommended). Must include any `output_schema.required` fields at their zero/empty values. |

### Optional fields

#### `dispatch_order`
Integer. Controls the order classifiers are scheduled in the worker pool — lower numbers run first. Classifiers without a `dispatch_order` sort last. Duplicate values are allowed (same-priority classifiers run adjacent). Does not block other classifiers; all classifiers always run concurrently up to the pool limit.

#### `applies_to`
`"user"` | `"assistant"` | `"both"`. Controls which pipeline pass runs this classifier:
- `"user"` (default) — runs during `classify()` against the latest user message
- `"assistant"` — runs during `inspect()` against the latest assistant message
- `"both"` — runs in both passes

#### `reserved_fields`
Array of reserved field names this classifier will emit. Reserved fields are consumed by the aggregator into routing decisions. Available reserved fields:

| Name | What it does |
|---|---|
| `final_reply` | Aggregator sets `action: "reply"` and returns `reply.text` directly to the user. |
| `ack_reply` | Aggregator populates `reply.text` as a holding message while downstream processes. |
| `model_tier` | Constrains the catalog resolver to a model tier (`"local_small"`, `"local_coding"`, `"frontier_fast"`, `"frontier_strong"`, `"frontier_coding"`). |
| `model_specialization` | Constrains the catalog resolver to a model specialization (`"chat"`, `"coding"`, `"reasoning"`, `"planning"`, `"writing"`, `"summarization"`, `"vision"`, `"tool_use"`, `"computer_use"`). |
| `tools` | Exposed tool ids passed to the downstream model. Requires `allowed_tools` to be declared. |
| `risk_level` | Injection risk assessment. `"high_risk"` or `"unknown"` triggers `action: "block"`. |

Highest-certainty contributor wins when multiple classifiers emit the same reserved field. Ties broken by `dispatch_order` ascending.

#### `allowed_tools`
Array of `{ id, description }` objects. Required when `reserved_fields` includes `"tools"`. Defines the universe of tool ids the classifier can select from. The LLM sees these descriptions when deciding which tools to expose.

```json
"allowed_tools": [
  { "id": "workspace", "description": "Local files, shell, and workspace state." },
  { "id": "web", "description": "Public web search and browsing." }
]
```

#### `output_schema`
JSON Schema fragment describing the classifier's custom output fields. Merged at load time with canonical sub-schemas for any declared `reserved_fields`, plus `reason` and `certainty`.

Sub-fields:

- **`properties`** — schema definitions for each custom field. Standard JSON Schema types, constraints, and enums are supported. Reserved field names cannot be redeclared here.
- **`required`** — array of property names that must be present in every successful output. Also required in `fallback`.
- **`examples`** — array of complete output objects shown to the LLM in the system prompt. When omitted, the runtime synthesizes a skeleton from the schema. Explicit examples improve output quality for complex or ambiguous schemas.

```json
"output_schema": {
  "required": ["sentiment"],
  "properties": {
    "sentiment": {
      "type": "string",
      "enum": ["positive", "neutral", "negative"]
    },
    "topics": {
      "type": "array",
      "items": { "type": "string", "maxLength": 40 },
      "maxItems": 5,
      "uniqueItems": true
    }
  },
  "examples": [
    {
      "reason": "User expressed frustration about a failed deployment.",
      "certainty": "strong",
      "sentiment": "negative",
      "topics": ["deployment", "errors"]
    },
    {
      "reason": "Casual greeting with no strong signal.",
      "certainty": "tentative",
      "sentiment": "neutral",
      "topics": []
    }
  ]
}
```

#### `backend`
Per-classifier model override. Takes priority over `runner.models` in `config.json` and `runner.defaultModel`.

```json
"backend": {
  "ollama": {
    "base_model": "llama3.2:3b-instruct-q4_K_M"
  }
}
```

---

## Minimal example

```json
{
  "name": "urgency",
  "version": "1.0.0",
  "purpose": "Classify whether the user's message is time-sensitive.",
  "dispatch_order": 45,
  "output_schema": {
    "required": ["is_urgent"],
    "properties": {
      "is_urgent": { "type": "boolean" }
    },
    "examples": [
      {
        "reason": "User asked to fix a production outage immediately.",
        "certainty": "near_certain",
        "is_urgent": true
      },
      {
        "reason": "User asked a general how-to question.",
        "certainty": "strong",
        "is_urgent": false
      }
    ]
  },
  "fallback": {
    "reason": "Classifier failed; urgency unknown.",
    "certainty": "no_signal",
    "is_urgent": false
  }
}
```

## Certainty values

| Label | Float | When to use |
|---|---|---|
| `no_signal` | 0.00 | No relevant signal; typically for fallbacks |
| `very_weak` | 0.15 | Extremely thin evidence |
| `weak` | 0.30 | Suggestive but inconclusive |
| `tentative` | 0.45 | Leans one way but uncertain |
| `reasonable` | 0.60 | Moderate confidence |
| `strong` | 0.75 | High confidence |
| `very_strong` | 0.88 | Near certain, minor ambiguity remains |
| `near_certain` | 0.97 | Unambiguous |

Omit optional fields rather than emitting a sentinel value — the LLM should express uncertainty through `certainty`, not through a placeholder like `"unknown"`.
