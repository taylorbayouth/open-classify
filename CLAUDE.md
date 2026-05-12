# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Clean dist/, tsc compile, copy classifier assets to dist/
npm test           # Build then run all tests (Node built-in test runner)
npm run setup      # First-time setup: check prereqs, install deps, pull Ollama model
npm run start      # Build + serve UI at http://127.0.0.1:4317/ (starts Ollama if needed)
npm run ui         # Build + serve UI only
```

Run a single test file:
```bash
node --test tests/pipeline.test.mjs
```

## Architecture

Open Classify is a **manifest-driven classifier runtime** that routes user messages to downstream AI models. Given a conversation, it runs classifiers concurrently and aggregates their outputs into a `PipelineResult` (`route | answer | block | needs_review`).

### Pipeline flow

```
OpenClassifyInput
  → input.ts       (normalize, truncate history to 20 msgs, hash target message)
  → pipeline.ts    (run all classifiers concurrently via Promise.allSettled)
      ↓ short-circuit: security "block"/"needs_review" or preflight "final"
  → aggregator.ts  (merge by confidence/order, resolve concrete model from catalog)
  → PipelineResult
```

### Classifiers

Each classifier lives under `src/classifiers/`:
- `manifest.json` - declares `order`, `emits`, `fallback`, optional `output_schema`
- custom classifiers also have `prompt.md`
- stock prompt markdown lives in `src/classifiers/stock/prompts/`

The 7 built-in classifiers (by order):

| Name | Order | Emits | Notes |
|---|---|---|---|
| `preflight` | 10 | `handoff` | Short-circuits on `kind: "final"` |
| `routing` | 20 | `routing` | Execution mode + model tier |
| `model_specialization` | 30 | `routing` | Specialization (coding, reasoning, etc.) |
| `conversation_history` | 40 | `context` | How much prior context downstream needs |
| `tools` | 50 | `tools` | Which tool families to expose |
| `memory_retrieval_queries` | 60 | `output` | Custom JSON output (validated by `output_schema`) |
| `security` | 70 | `safety` | Short-circuits on `block`/`needs_review` |

Short-circuit gates: only `handoff.kind === "final"` (preflight) and `safety.decision` of `block`/`needs_review` (security) can abort the pipeline early.

### Key source files

- `src/pipeline.ts` — Orchestrates concurrent classifier execution and short-circuit logic
- `src/aggregator.ts` — Merges classifier outputs; calls model resolver against catalog
- `src/classifiers.ts` — Loads manifests from disk, validates registry (duplicate orders rejected)
- `src/ollama.ts` — Reference LLM backend; packs prompts, handles timeouts, parses JSON
- `src/catalog.ts` — Loads `downstream-models.json`; model resolver picks concrete model
- `src/manifest.ts` — All runtime TypeScript types (`PipelineResult`, `Catalog`, `Envelope`, etc.)
- `src/stock.ts` — Interfaces for stock classifier signal shapes
- `src/enums.ts` — Categorical enums (execution modes, model tiers, specializations, etc.)
- `src/input.ts` — Input normalization and validation
- `src/ui-server.ts` — Tiny HTTP server; streams classification progress via Server-Sent Events

### Classifier output contract

Every classifier returns at minimum:
```ts
{ reason: string /* ≤120 chars */, confidence: number /* 0–1 */ }
```

Plus optional stock signals (`handoff`, `routing`, `context`, `tools`, `safety`, `response`, `summary`) declared in the manifest's `emits` field, and an optional custom `output` validated by `output_schema`.

Confidence normalization: the runtime accepts 0–100 ranges, percentages, and text labels (`"low"/"medium"/"high"`) and normalizes them to 0–1.

Classifiers that fail use their manifest `fallback` output (`confidence: 0`); failures are recorded in `audit.meta.classifiers[name].status`.

### Configuration files

- `downstream-models.json` — Required catalog of available downstream models
- `adapter-models.json` — Optional per-classifier Ollama model overrides
- Base model: `gemma4:e4b-it-q4_K_M` at 4096-token context window per classifier

### Design constraints

- **No escape-hatch enums** — Classifiers omit uncertain optional fields instead of emitting sentinel values like `"unable_to_determine"`
- **No model IDs from classifiers** — Classifiers emit routing *constraints*; the aggregator + catalog resolver picks the concrete model
- **No keyword/regex mock classifiers** — All classifiers must use real model calls; no pattern-matching stubs
- **Order is declarative** — Duplicate orders are rejected at load time; lower order wins on confidence ties
- **Attachments are metadata only** — Classifiers see filename/size/mime type, never content
