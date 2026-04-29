# llm-harness

Lean LLM harness for cost-aware, reliable routing. Classifies user requests across 5 dimensions in parallel, applies deterministic routing rules, and emits a full trace for every decision.

## Setup

```bash
npm install
```

If using Ollama, start it with concurrency enabled (the harness fires 5 parallel classifier calls):

```bash
OLLAMA_NUM_PARALLEL=5 ollama serve
```

## Usage

### Web UI

```bash
npm run server
```

Open http://localhost:3000 — submit requests from the browser or via POST.

### CLI

```bash
npx tsx src/cli.ts classify "Can you look up the latest OpenAI API pricing?"
npx tsx src/cli.ts classify "Debug this function" --pretty
npx tsx src/cli.ts classify "Send the invoice" --model openai/gpt-4o-mini
```

### POST /classify

```bash
curl -X POST http://localhost:3000/classify \
  -H "Content-Type: application/json" \
  -d '{"user_input": "What is the current AWS Lambda pricing?"}'
```

## Config

Create `harness.config.json` (or set env vars):

```json
{
  "classifier": {
    "model": "ollama/qwen3:8b",
    "timeout_ms": 15000
  },
  "routing": {
    "avg_confidence_threshold": 0.65,
    "min_confidence_threshold": 0.4,
    "fallback_route": "billed_mini"
  }
}
```

Env overrides: `HARNESS_MODEL`, `HARNESS_BASE_URL`, `HARNESS_TIMEOUT_MS`, `HARNESS_AVG_CONFIDENCE_THRESHOLD`, `HARNESS_MIN_CONFIDENCE_THRESHOLD`, `OPENAI_API_KEY`.

## Models

- **Ollama**: `ollama/qwen3:8b`, `ollama/gemma2:9b`, etc.
- **OpenAI**: `openai/gpt-4o-mini`, `openai/gpt-4o`

## Architecture

5 parallel sub-classifiers, each answering one narrow question:

| Dimension | Enum |
|-----------|------|
| `task_class` | `chat \| draft \| code \| research \| unknown` |
| `needs_memory` | `none \| recent \| session \| long_term` |
| `tools_required` | `true \| false` |
| `suggested_model` | `local_fast \| local_slow \| billed_mini \| billed_frontier` |
| `security` | `clean \| suspicious \| prompt_injection` |

Each classifier returns its value plus a `confidence` 0–1. The aggregator computes `average_confidence` and `min_confidence`. The router escalates to `billed_frontier` when confidence is too low, regardless of `suggested_model`.

See [docs/architecture.md](docs/architecture.md) for full details.

## Tests

```bash
npm test
```
