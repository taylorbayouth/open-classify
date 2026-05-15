# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Clean dist/, tsc compile, copy classifier assets to dist/
npm test           # Build then run all tests (Node built-in test runner)
npm run setup      # First-time setup: check prereqs, install deps, pull Ollama model
```

Run a single test file:
```bash
node --test tests/pipeline.test.mjs
```

## Architecture

Open Classify is a **manifest-driven classifier runtime** that routes user messages to downstream AI models. Given a conversation, it runs classifiers concurrently through a bounded worker pool and aggregates their outputs into a `PipelineResult` whose `action` is always `"route"`. The caller decides whether to act on `audit.final_reply`, `audit.prompt_injection`, etc.

### Pipeline flow

```
OpenClassifyInput
  → input.ts       (normalize, truncate history to 20 msgs, hash target message)
  → pipeline.ts    (run classifiers concurrently in a worker pool capped by maxConcurrency)
  → aggregator.ts  (pick reserved fields by certainty, resolve concrete model from catalog)
  → PipelineResult
```

There are no short-circuit gates. Every classifier always runs; advisory signals (final_reply, risk_level, etc.) are surfaced in the audit envelope for the caller to consume.

### Classifiers

Each classifier lives under `src/classifiers/<name>/` with exactly two files:
- `manifest.json` — declares `name`, `version`, `purpose`, optional `dispatch_order`, `applies_to`, `output_schema`, `fallback`, and optionally `reserved_fields` + `allowed_tools` + `backend` hints
- `prompt.md` — the classifier-specific instructions

Shared base prompt fragments live in `src/classifiers/_prompts/`. Directories whose names start with `_` are skipped by the loader.

There is no "stock" vs "custom" distinction. Every classifier uses the same contract. What used to be a stock classifier is now a regular classifier that happens to opt into one or more **reserved fields** (well-known output keys the aggregator knows how to consume).

The built-in classifiers (by dispatch_order):

| Name | dispatch_order | Reserved fields | applies_to |
|---|---|---|---|
| `preflight` | 10 | `final_reply`, `ack_reply` | `user` |
| `routing` | 20 | `model_tier` | `user` |
| `model_specialization` | 30 | `model_specialization` | `user` |
| `tools` | 40 | `tools` | `user` |
| `prompt_injection` | 50 | `risk_level` | **`both`** |
| `memory_retrieval_queries` | 60 | — | `user` |
| `conversation_digest` | 70 | — | `user` |
| `context_shift` | 80 | — | `user` |

### Two passes: `classify()` and `inspect()`

`createClassifier()` returns `{ classify, inspect }`. `classify()` is the user-input pass (full `PipelineResult` with `downstream` + `audit`). `inspect()` is the lean assistant-output pass (`{ target_message_hash, classifier_outputs }` only — no routing, no audit). Each pass runs only the classifiers tagged for it via `applies_to` (default `"user"`).

### Key source files

- `src/pipeline.ts` — Worker-pool dispatch; assembles `PipelineResult.classifier_outputs` (every classifier's payload, reason/certainty stripped)
- `src/aggregator.ts` — Extracts reserved fields by name (highest-certainty wins; ties broken by manifest `dispatch_order` ascending); resolves concrete model from catalog
- `src/classifiers.ts` — Loads manifests from `src/classifiers/<name>/`; composes prompt and validation schema; validates registry
- `src/stock-validation.ts` — Single validation path: manifest validation + per-output validation against the composed schema
- `src/stock-prompt.ts` — Single prompt builder: base sections + classifier header + auto-injected reserved-field fragments + `prompt.md` + `output_schema.examples`
- `src/reserved-fields.ts` — Central registry of reserved field definitions (canonical sub-schemas + prompt fragments)
- `src/ollama.ts` — Reference LLM backend; packs prompts, handles timeouts, parses JSON
- `src/catalog.ts` — Loads `downstream-models.json`; model resolver picks concrete model
- `src/manifest.ts` — Pipeline result types (`PipelineResult`, `Catalog`, `Envelope`, etc.)
- `src/stock.ts` — Classifier-facing types (signals, certainty, manifest interfaces). The "stock" name is historical; types apply to all classifiers.
- `src/enums.ts` — Categorical enums (model tiers, specializations, risk levels)
- `src/input.ts` — Input normalization and validation

### Classifier output contract

Every classifier returns a flat JSON object:

```ts
{
  reason: string;        // ≤120 chars
  certainty: Certainty;  // "no_signal" | "very_weak" | "weak" | "tentative" | "reasonable" | "strong" | "very_strong" | "near_certain"
  // ...any reserved fields declared in the manifest, at the top level
  // ...any custom properties declared in output_schema.properties, at the top level
}
```

There is no `output` wrapper. Reserved fields and custom fields sit alongside `reason` and `certainty` at the top level.

Certainty scoring: the aggregator maps certainty tags to numeric scores. Reserved-field values below the configured threshold (default `0.65`) are dropped from the envelope's named slots but still appear in `audit.classifier_outputs[]` and `meta.classifiers[name]`. There is no whole-run certainty gate that blocks routing — `min` and `avg` are reported in `audit.meta.certainty` for the caller to act on.

Classifiers that fail use their manifest `fallback` output; failures are recorded in `audit.meta.classifiers[name].status`.

### Reserved fields

`final_reply`, `ack_reply`, `model_tier`, `model_specialization`, `tools`, `risk_level`. The runtime owns their canonical JSON Schema sub-schemas and prompt fragments — manifests just declare opt-in via the `reserved_fields` array. Multiple classifiers can emit the same reserved field; highest certainty wins, ties broken by manifest `dispatch_order` ascending (classifiers without `dispatch_order` sort last).

### Configuration files

- `downstream-models.json` — Required catalog of available downstream models
- `open-classify.config.example.json` — Example runtime config: Ollama model overrides (flat `models: { [name]: model_id }`), aggregator settings, catalog path
- Base classifier model: `gemma4:e4b-it-q4_K_M`

### Design constraints

- **No escape-hatch enums** — Classifiers omit uncertain optional fields instead of emitting sentinel values like `"unable_to_determine"`
- **No model IDs from classifiers** — Classifiers emit routing *constraints*; the aggregator + catalog resolver picks the concrete model
- **No keyword/regex mock classifiers** — All classifiers must use real model calls; no pattern-matching stubs
- **Dispatch order is declarative and optional** — Duplicate names are rejected; duplicate `dispatch_order` values are allowed (same-priority classifiers schedule adjacent in the worker pool). Manifests without `dispatch_order` sort last (treated as +Infinity).
- **Reserved field names are runtime-owned** — Manifests can't redeclare canonical enum values for reserved fields, so they can't drift from `src/enums.ts`
