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

Open Classify is a **manifest-driven classifier runtime** that routes user messages to downstream AI models. Given a conversation, it runs classifiers concurrently through a bounded worker pool and aggregates their outputs into a flat `PipelineResult`.

### Pipeline flow

```
OpenClassifyInput
  → input.ts       (normalize, truncate history to 20 msgs, hash target message)
  → pipeline.ts    (run classifiers concurrently in a worker pool capped by maxConcurrency)
  → aggregator.ts  (pick reserved fields by certainty, resolve concrete model from catalog)
  → PipelineResult
```

Every classifier always runs. The result `action` is `"route"`, `"block"`, or `"reply"` — determined by the aggregator after all classifiers complete.

### Classifiers

Each classifier lives in a directory with exactly two files:
- `manifest.json` — declares `name`, `version`, `purpose`, optional `dispatch_order`, `applies_to`, `output_schema`, `fallback`, and optionally `reserved_fields` + `allowed_tools` + `backend` hints
- `prompt.md` — the classifier-specific instructions

Shared base prompt fragments live in `src/classifiers/_prompts/`. Directories whose names start with `_` are skipped by the loader — that's the only on/off mechanism. Consumers can use the same trick: rename `my_classifier/` → `_my_classifier/` to deactivate without deleting.

There is no "stock" vs "custom" distinction. Every classifier uses the same contract. What used to be a stock classifier is now a regular classifier that happens to opt into one or more **reserved fields** (well-known output keys the aggregator knows how to consume).

#### Mandatory built-ins (live in `src/classifiers/`)

| Name | dispatch_order | Reserved fields | applies_to |
|---|---|---|---|
| `preflight` | 10 | `final_reply`, `ack_reply` | `user` |
| `model_tier` | 20 | `model_tier` | `user` |
| `model_specialization` | 30 | `model_specialization` | `user` |
| `prompt_injection` | 50 | `risk_level` | **`both`** |

These always load. Extras can't override them — name collisions throw. To customize behaviour, use a custom `RunClassifier`.

#### Templates (live in `templates/` at the package root)

| Name | dispatch_order | Reserved fields | applies_to |
|---|---|---|---|
| `tools` | 40 | `tools` | `user` |
| `memory_retrieval_queries` | 60 | — | `user` |
| `conversation_digest` | 70 | — | `user` |
| `context_shift` | 80 | — | `user` |

These ship with the package but the runtime never loads them. `npx open-classify init` copies them into the consumer's `classifiers/` directory as `_<name>/` (inactive). The consumer activates one by dropping the underscore (`mv _tools tools`).

### CLI

`bin/open-classify.mjs` is a plain ESM script (no compile step) registered via the package's `bin` field. Currently exposes one subcommand:

- `init [--yes]` — scaffold `open-classify.config.json` + `classifiers/` (with `README.md` + the four `_<template>/` directories). Strictly never overwrites existing files; if everything's present, prints "Nothing to do." Y/n confirmation skipped by `--yes`. Integration-tested in `tests/cli-init.test.mjs` by spawning the script in a temp dir.

### Two passes: `classify()` and `inspect()`

`createClassifier()` returns `{ classify, inspect }`. `classify()` is the user-input pass (full `PipelineResult`). `inspect()` is the lean assistant-output pass (`{ target_message_hash, message, classifier_outputs }` — no routing, no action). Each pass runs only the classifiers tagged for it via `applies_to` (default `"user"`).

### Key source files

- `src/pipeline.ts` — Worker-pool dispatch; calls `assembleResult`; returns `PipelineResult`
- `src/aggregator.ts` — `assembleResult()`: picks reserved fields by certainty, determines action, resolves model; `buildPublicOutputs()`: converts certainty to float
- `src/classifiers.ts` — Loads manifests from `src/classifiers/<name>/`; composes prompt and validation schema; validates registry
- `src/stock-validation.ts` — Single validation path: manifest validation + per-output validation against the composed schema
- `src/stock-prompt.ts` — Single prompt builder: base sections + classifier header + auto-injected reserved-field fragments + `prompt.md` + `output_schema.examples`
- `src/reserved-fields.ts` — Central registry of reserved field definitions (canonical sub-schemas + prompt fragments)
- `src/ollama.ts` — Reference LLM backend; packs prompts, handles timeouts, parses JSON
- `src/catalog.ts` — Loads `downstream-models.json`; model resolver picks concrete model
- `src/manifest.ts` — Pipeline result types (`PipelineResult`, `InspectResult`, `Catalog`, etc.)
- `src/stock.ts` — Classifier-facing types (signals, certainty, manifest interfaces). The "stock" name is historical; types apply to all classifiers.
- `src/enums.ts` — Categorical enums (model tiers, specializations, risk levels)
- `src/input.ts` — Input normalization and validation

### PipelineResult shape

```ts
{
  action: "route" | "block" | "reply";
  block_reason?: "prompt_injection" | "classification_error";
  target_message_hash: string;
  model_id: string | null;
  tools: ReadonlyArray<string>;
  reply: { text: string } | null;
  prompt_injection: { risk_level: PromptInjectionRiskLevel } | null;
  avg_certainty: number;
  min_certainty: number;
  failed_classifiers: ReadonlyArray<string>;
  classifier_outputs: ClassifierPublicOutputs;
}
```

- `action: "reply"` — `preflight` emitted `final_reply`; return `reply.text` to the user directly.
- `action: "block"` — either injection risk (`block_reason: "prompt_injection"`) or runtime failure (`block_reason: "classification_error"`). `model_id` and `reply` are still populated when available.
- `action: "route"` — route to `model_id` with `tools`; show `reply.text` (the ack) while downstream works.
- `classifier_outputs[name]` includes all payload fields plus `reason` (string) and `certainty` (float).
- `tools` is always an array (empty if no classifier emitted it).

### Block triggers

- **`prompt_injection`**: `risk_level` is `"high_risk"` or `"unknown"`, regardless of certainty. This takes priority.
- **`classification_error`**: any classifier failed/timed out (listed in `failed_classifiers`), or preflight provided no reply, or `model_id` could not be resolved.

When `prompt_injection` classifier itself fails at runtime, its fallback has **no `risk_level`** — so the block fires as `classification_error`, not `prompt_injection`. A classifier failure is distinct from an assessed risk.

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

Certainty: labels stay internal (LLM understands them); floats appear in the final `PipelineResult`. The aggregator picks the highest-certainty contributor when multiple classifiers emit the same reserved field — no threshold gate. Classifiers that fail use their manifest `fallback`; failures appear in `failed_classifiers`.

### Reserved fields

`final_reply`, `ack_reply`, `model_tier`, `model_specialization`, `tools`, `risk_level`. The runtime owns their canonical JSON Schema sub-schemas and prompt fragments — manifests just declare opt-in via the `reserved_fields` array. Multiple classifiers can emit the same reserved field; highest certainty wins, ties broken by manifest `dispatch_order` ascending (classifiers without `dispatch_order` sort last).

Fallback validation: only `reason` and `certainty` are required in a fallback object. Reserved fields and `output_schema.required` entries are exempt — the "no signal" state cannot meaningfully populate them.

### Configuration files

- `downstream-models.json` — Required catalog of available downstream models
- `open-classify.config.example.json` — Example runtime config: Ollama model overrides (flat `models: { [name]: model_id }`), catalog path
- Base classifier model: `gemma4:e4b-it-q4_K_M`

### Design constraints

- **No escape-hatch enums** — Classifiers omit uncertain optional fields instead of emitting sentinel values like `"unable_to_determine"`
- **No model IDs from classifiers** — Classifiers emit routing *constraints*; the aggregator + catalog resolver picks the concrete model
- **No keyword/regex mock classifiers** — All classifiers must use real model calls; no pattern-matching stubs
- **Dispatch order is declarative and optional** — Duplicate names are rejected; duplicate `dispatch_order` values are allowed (same-priority classifiers schedule adjacent in the worker pool). Manifests without `dispatch_order` sort last (treated as +Infinity).
- **Reserved field names are runtime-owned** — Manifests can't redeclare canonical enum values for reserved fields, so they can't drift from `src/enums.ts`
