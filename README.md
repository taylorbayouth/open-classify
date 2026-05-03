# llm-harness

Lean LLM harness that classifies inbound user requests across 5 narrow dimensions in parallel and emits a full trace for every decision.

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

Create `harness.config.json` (or `harness.config.local.json`, or set env vars). Each of the 5 sub-classifiers has its own model — they can all share one or each pick a different model.

```json
{
  "classifiers": {
    "awk":             { "model": "ollama/gemma3:4b",  "timeout_ms": 15000 },
    "response_path":   { "model": "ollama/qwen3:8b",   "timeout_ms": 15000 },
    "context_budget":  { "model": "ollama/qwen3:8b",   "timeout_ms": 15000 },
    "retrieval_need":  { "model": "ollama/qwen3:8b",   "timeout_ms": 15000 },
    "work_complexity": { "model": "ollama/qwen3:8b",   "timeout_ms": 15000 }
  },
  "routing": {
    "avg_confidence_threshold": 0.65,
    "min_confidence_threshold": 0.4
  }
}
```

Env overrides: `HARNESS_MODEL`, `HARNESS_BASE_URL`, `HARNESS_TIMEOUT_MS`, `HARNESS_AVG_CONFIDENCE_THRESHOLD`, `HARNESS_MIN_CONFIDENCE_THRESHOLD`, `OPENAI_API_KEY`.

## Models

- **Ollama**: `ollama/qwen3:8b`, `ollama/gemma2:9b`, etc.
- **OpenAI**: `openai/gpt-4o-mini`, `openai/gpt-4o`

## Architecture

5 parallel sub-classifiers, each answering one narrow question:

| Dimension | Shape |
|-----------|-------|
| `awk` | `{ text: string (≤280), mode: "only" \| "first" \| "question", should_send: bool, confidence: 0–1 }` — the immediate user-facing acknowledgement |
| `response_path` | `none \| small_model \| large_model \| tool_assisted \| workflow` — what (if anything) happens after the awk |
| `context_budget` | `none \| current_message_only \| last_exchange \| recent_context \| retrieved_context_only \| full_conversation` |
| `retrieval_need` | array of `none \| memory \| files \| web \| browser \| email_calendar \| system_local_state \| other` |
| `work_complexity` | `trivial \| simple \| moderate \| complex \| multi_step` |

Each classifier returns its value plus a `confidence` 0–1. When the average confidence falls below `avg_confidence_threshold`, or any single classifier dips below `min_confidence_threshold`, the UI overrides to a safe default (`awk.mode = "question"`, `response_path = "none"`) instead of acting on a low-confidence read.

See [docs/architecture.md](docs/architecture.md) for full details.

## Tests

```bash
npm test
```
