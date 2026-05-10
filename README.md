# Open Classify

Open Classify is an npm package that runs a registry of specialized classifiers concurrently on every inbound message before it reaches your main model.

Its primary job is not to reply — it classifies. But when a message is self-contained and needs no tools, additional context, or external state, Open Classify can respond directly and short-circuit the pipeline entirely. A simple acknowledgment, a social exchange, a clarifying one-liner: if a classifier with a `shortCircuit` rule determines the reply is complete, your frontier model never sees it.

**Why use it:**

- **Cost** — Short-circuited messages never reach a frontier model. Every "thanks" or "sounds good" that resolves at classification saves a full LLM call.
- **Speed** — Every message gets an instant acknowledgment. Preflight decides ack vs. route immediately, so users are never waiting in silence while routing decisions are made.
- **Quality** — When the pipeline routes forward, Open Classify tells your downstream model exactly what it needs: how much conversation history is relevant, which memory queries to run before constructing the prompt, which tool families to expose (not the full manifest on every call), and which configured model fits the request.

The bundled classifier set is opinionated and ships ready to use. The framework is modular — each classifier is a self-contained `ClassifierModule` under `src/classifiers/<name>/`, and the registry tuple in `src/classifiers.ts` is the single place that lists them all. See **Adding a classifier** below.

## Install

```sh
npm install open-classify
```

Requires Node.js ≥ 18 and [Ollama](https://ollama.com) running locally with `gemma4:e4b-it-q4_K_M`.

## Classifiers

The bundled registry runs seven classifiers in parallel on every message.

| Classifier | What it does | Short-circuit? |
|---|---|---|
| **Preflight** | Decides whether to reply immediately or route to the downstream model | Yes (`kind: "final"` on `terminality === "terminal"`) |
| **Routing** | Recommends the execution mode and model tier for the request | — |
| **Conversation History** | Recommends how many visible prior messages the downstream model should include | — |
| **Memory Retrieval Queries** | Predicts which memory searches to run before constructing the prompt | — |
| **Tools** | Identifies which tool families to expose to the downstream model | — |
| **Model Specialization** | Chooses the model or prompt specialization best suited to the message | — |
| **Security** | Flags prompt injection, unsafe actions, and permission boundary risks | Yes (`kind: "block"` on `risk_level === "high_risk"`) |

Modules with `shortCircuit` are awaited in priority order (preflight at 0, security at 10). If any returns a verdict, the pipeline aborts the rest and emits a `short_circuit` envelope.

Every classifier's output extends a common base — `{ reason: string; confidence: number }`. The `confidence` field (0..1) is honest self-assessment: 0.5 is "default behavior, no strong signal"; 0.9+ should be rare. Fallback outputs (when a classifier errors or times out) emit `confidence: 0`, which auto-drops them from threshold-gated decisions like the model resolver.

### Preflight

Determines whether the message can be answered immediately or needs downstream planning.

Values: `terminal`, `continue`, `unable_to_determine`. Fields: `terminality`, `reply`, `reason`, `confidence`.

**"Thanks, that makes sense."** → Terminal. Pipeline emits `short_circuit/final` with `reply: "Anytime."` and the other classifiers are aborted.

### Routing

Execution modes: `direct` · `tool_assisted` · `workflow` · `unable_to_determine`. Tiers: `local_fast` · `local_strong` · `frontier_fast` · `frontier_strong` · `unable_to_determine`. Fields: `execution_mode`, `model_tier`, `reason`, `confidence`.

Feeds the model resolver — see **Model recommendation**.

### Conversation History

Fields: `is_standalone`, `refers_to_history`, `relevant_conversation_history`, `needs_unseen_history`, `reason`, `confidence`. Contributes to the route envelope's `relevant_conversation_history` and `requires_full_message_history` slots.

### Memory Retrieval Queries

Up to three short query hints, or empty when no prior context is likely to help. Fields: `queries`, `reason`, `confidence`. Contributes the `memory_queries` slot.

### Tools

Families: `web`, `email_and_chat`, `calendar`, `files`, `docs_and_sheets`, `tasks_and_projects`, `code`, `business_apps`. Fields: `needed`, `families`, `reason`, `confidence`. Contributes the `tool_families` slot.

### Model Specialization

Values: `chat`, `writing`, `reasoning`, `planning`, `coding`, `instruction_following`, `unclear`. Fields: `model_specialization`, `reason`, `confidence`. Feeds the model resolver.

### Security

Risk levels: `normal`, `suspicious`, `high_risk`, `unable_to_determine`. Signals: `instruction_attack`, `secret_or_private_data_risk`, `unsafe_tool_or_action`, `untrusted_content_or_code`, `injection_or_obfuscation`. Fields: `risk_level`, `signals`, `reason`, `confidence`. Contributes the `safety_signals` slot and short-circuits with `kind: "block"` on `high_risk`.

## Usage

```ts
import { classifyWithOllama, EXAMPLE_CATALOG } from "open-classify";

const result = await classifyWithOllama(
  {
    messages: [{ role: "user", text: "Can you review this?" }],
  },
  { catalog: EXAMPLE_CATALOG },
);
```

Pass a `messages` array ending with the user message to classify. Optional `attachments` carry filename, size, and MIME type only — Open Classify never reads file contents.

The `catalog` argument is required for the route path (where the model resolver runs). See **Model catalog**.

### Pipeline output: two variants

The result is one of two shapes, discriminated by `decision`.

```ts
// Short-circuited by a module's shortCircuit rule
{
  decision: "short_circuit",
  target_message_hash: "a3f8c1d2",
  fired_by: "preflight",                  // which module's rule fired
  kind: "final",                          // "final" | "block" | "clarify"
  reply: "Anytime.",                      // present on "final" and "clarify", absent on "block"
  meta: { classifiers: { /* modules that finished before the abort */ } }
}
```

```ts
// Normal route — every classifier ran (or fell back) and the envelope is composed
{
  decision: "route",
  target_message_hash: "c4d8e1f3",
  model_recommendation: {
    id: "gpt-5.3-codex",
    params_in_millions: 30000,
    context_window: 500000,
    resolution: {
      constraints_used: { specialization: "coding", execution_mode: "tool_assisted", tier: "frontier_fast" },
      constraints_dropped: [],
      confidences: { model_specialization: 0.88, routing: 0.81 },
      fell_back_to_default: false
    }
  },
  // Optional slot fields — only present if at least one module contributed:
  quick_reply: { text: "Let me check.", kind: "ack" },
  relevant_conversation_history: [/* trimmed message tail */],
  requires_full_message_history: false,
  memory_queries: ["prior auth approach"],
  tool_families: ["code"],
  safety_signals: { risk_level: "normal", signals: [] },
  meta: { classifiers: { /* full per-classifier entries */ } }
}
```

`model_recommendation` is the only guaranteed field on the route variant — the catalog's `default` ensures it's always populated. Every other slot field is optional and present only when a module actually contributed.

Each `meta.classifiers[name]` entry is the classifier's full verdict plus `status` (where `status.ok === false` means the classifier fell back to a conservative default with `confidence: 0`) and `version` (the module's manifest version).

On a `short_circuit` envelope, `meta.classifiers` contains every module that finished before the abort. Preflight at priority 0 fires before security at 10, so a security-driven block also includes preflight's entry.

## Model catalog

`downstream-models.json` (or your in-memory `Catalog`) is the only source of truth for downstream-model metadata. Classifiers never emit model ids, parameter counts, or context windows — the catalog declares those, and the aggregator's resolver picks the matching entry.

```json
{
  "models": [
    {
      "id": "gpt-5.5",
      "specializations": ["reasoning", "coding", "writing", "planning", "chat", "instruction_following"],
      "execution_modes": ["direct", "tool_assisted", "workflow"],
      "tiers": ["frontier_strong"],
      "params_in_millions": 800000,
      "context_window": 1000000
    },
    {
      "id": "gpt-5.3-codex",
      "specializations": ["coding"],
      "execution_modes": ["direct", "tool_assisted"],
      "tiers": ["frontier_fast"],
      "params_in_millions": 30000,
      "context_window": 500000
    }
  ],
  "default": "gpt-5.4-mini"
}
```

Each entry advertises **set membership** on three axes (a model can fit multiple specializations / execution modes / tiers). All fields are required per entry. Loading is **strict** — missing file, unparseable JSON, unsupported axis values, duplicate ids, or a `default` that doesn't reference a real entry all throw at init.

### Resolution algorithm

The resolver gathers categorical signals from `model_specialization` and `routing`, gated by their `confidence` (default threshold **0.6**, override via `confidenceThreshold` in pipeline config). Anything below threshold or with an escape-hatch value (`unclear` / `unable_to_determine`) is dropped. Remaining constraints filter the catalog; among the survivors, **biggest `params_in_millions` wins** (tiebreak on `context_window`). Zero confident signals → biggest model in the entire catalog. No catalog entry matches → falls back to `catalog.default`.

This means low confidence widens the candidate pool. The resolver tells you what it did via `model_recommendation.resolution`.

Pass your catalog by value or by path:

```ts
import { classifyWithOllama, loadCatalog } from "open-classify";

// Pre-loaded (preferred — load once at startup, reuse)
const catalog = loadCatalog("./downstream-models.json");
await classifyWithOllama(input, { catalog });

// Or by path (each call re-reads + re-validates)
await classifyWithOllama(input, { catalogPath: "./downstream-models.json" });
```

## Adding a classifier

A classifier is a directory under `src/classifiers/<name>/` with four files, plus one line in `src/classifiers.ts`. The type system flags every consumer that needs updating.

```
src/classifiers/sentiment/
  prompt.ts      // system prompt as a string
  result.ts      // Result type, validator, fallback, max-length constants
  fixtures.ts    // a valid sample output for tests + UI
  module.ts      // the manifest object
```

The module:

```ts
import type { ClassifierModule, Contribution } from "../../manifest.js";
import { SENTIMENT_SYSTEM_PROMPT } from "./prompt.js";
import { SENTIMENT_FALLBACK, validateSentiment, type SentimentResult } from "./result.js";

const sentimentContribution: Contribution<SentimentResult> = {
  slot: "quick_reply",                 // or any other EnvelopeSlots key
  priority: 5,                         // lower wins when multiple modules contribute
  build: (result) =>
    result.sentiment === "frustrated"
      ? { text: "Let me look at that.", kind: "ack" }
      : undefined,                     // return undefined to abstain
};

export const sentimentModule: ClassifierModule<"sentiment", SentimentResult> = {
  name: "sentiment",
  version: "1.0.0",
  purpose: "Detect user sentiment and adjust the interim acknowledgement tone.",
  systemPrompt: SENTIMENT_SYSTEM_PROMPT,
  validate: validateSentiment,
  fallback: SENTIMENT_FALLBACK,        // must set confidence: 0
  contributions: [sentimentContribution],
  shortCircuit: undefined,             // or { priority, evaluate } for an early-exit rule
  backends: { ollama: { adapterModel: "open-classify-sentiment:v0.1.0" } },
  ui: { label: "Sentiment", optionEnum: ["happy", "neutral", "frustrated"], renderer: "enum" },
};
```

Then add it to the registry:

```ts
// src/classifiers.ts
export const REGISTRY = [
  preflightModule,
  routingModule,
  // ...
  sentimentModule,                     // ← that's the whole edit
] as const;
```

Removing a module is the inverse: delete its directory, remove its line from `REGISTRY`. TypeScript points at every consumer that referenced the removed name.

### Envelope slots

A module's `contributions[]` can target any of these slots:

| Slot | Type | Default merge rule |
|---|---|---|
| `relevant_conversation_history` | `ConversationMessageInput[]` | longest array wins |
| `requires_full_message_history` | `boolean` | OR across contributors |
| `memory_queries` | `string[]` | concat + dedupe |
| `tool_families` | `string[]` | union + dedupe |
| `safety_signals` | `{ risk_level, signals[] }` | highest risk level; union signals |
| `quick_reply` | `{ text, kind: "final" \| "ack" \| "clarify", show_after_ms? }` | highest-priority contributor wins |
| `expected_response_length` | `"short" \| "medium" \| "long"` | highest-priority wins |
| `output_format_hint` | `"markdown" \| "plain" \| "json" \| "code"` | highest-priority wins |
| `language` | string (BCP-47) | highest-priority wins |
| `pii` | `{ present, categories[] }` | OR `present`; union categories |
| `attachment_relevance` | `[{ hash, keep, reason? }]` | union by hash; keep wins on conflict |

The caller can override any merge rule via `mergeOverrides` in pipeline config.

### Validators

Per-module validators are hand-rolled with shared helpers from `src/validation.ts` (no Zod dependency). The contract is:

```ts
import { ensureExactKeys, requireConfidence, requireEnum, requireStringMaxLength } from "../../validation.js";
import type { ClassifierValidationContext } from "../../manifest.js";

export function validateSentiment(value: Record<string, unknown>, ctx: ClassifierValidationContext): SentimentResult {
  ensureExactKeys(value, ["sentiment", "reason", "confidence"], ctx.name, ctx.model);
  return {
    sentiment: requireEnum(value.sentiment, SENTIMENT_VALUES, ctx.name, ctx.model, "sentiment"),
    reason: requireStringMaxLength(value.reason, ctx.name, ctx.model, "reason", 200),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}
```

Validators throw `ClassifierValidationError` on bad input. The Ollama runner wraps these at the boundary as `OllamaClassifierError` so the public API stays stable.

## Runtime

Open Classify ships with an Ollama runner using `gemma4:e4b-it-q4_K_M`. Classifier calls run in parallel; the runner enforces a small per-call context budget (4096 tokens) so all of them fit on a single workstation-class GPU.

Per-classifier adapter ids come from each module's `backends.ollama.adapterModel` and are surfaced via the auto-derived `OLLAMA_CLASSIFIER_ADAPTER_MODELS` map. `adapter-models.json` on disk can override these at runtime.

You can implement your own backend by satisfying the `RunClassifier` type and passing it to `classifyOpenClassifyInput`:

```ts
import { classifyOpenClassifyInput, type RunClassifier } from "open-classify";

const runClassifier: RunClassifier = async (name, input, signal) => {
  /* call your model, validate the JSON, return the typed Result */
};

const result = await classifyOpenClassifyInput(input, { runClassifier, catalog });
```

Start Ollama with the right settings:

```sh
OLLAMA_NUM_PARALLEL=7 \
OLLAMA_MAX_LOADED_MODELS=7 \
OLLAMA_CONTEXT_LENGTH=4096 \
ollama serve
```

`npm run start` handles this automatically.

## Local Workbench

```sh
npm run setup
npm run start
```

Opens a workbench UI at `http://127.0.0.1:4317/` for testing classifiers interactively. Streams classifier results as they arrive. Reads `/api/classifiers` to discover the active registry — no hardcoded module list in the UI.
