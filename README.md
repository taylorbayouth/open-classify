# llm-harness

Lean LLM harness for cost-aware, reliable routing. Classifies user requests before sending them to a model, applies deterministic routing rules, and emits a full trace for every decision.

## Setup

```bash
npm install
```

## Usage

### Web UI (recommended for live testing)

```bash
npm run harness -- server   # or: tsx src/server.ts
```

Open http://localhost:3000 — submit requests from the browser or via POST.

### CLI

```bash
tsx src/cli.ts classify "Can you look up the latest OpenAI API pricing?"
tsx src/cli.ts classify "Debug this function" --mock --pretty
tsx src/cli.ts classify "Send the invoice" --model openai/gpt-4o-mini
```

### POST /classify

```bash
curl -X POST http://localhost:3000/classify \
  -H "Content-Type: application/json" \
  -d '{"user_input": "What is the current AWS Lambda pricing?", "mock": true}'
```

## Config

Create `harness.config.json` in the project root (or set env vars):

```json
{
  "classifier": {
    "model": "ollama/qwen3:8b",
    "timeout_ms": 1500,
    "confidence_threshold": 0.65
  },
  "routing": {
    "default_model_tier": "mini",
    "high_risk_model_tier": "frontier",
    "research_model_tier": "frontier"
  }
}
```

Env overrides: `HARNESS_MODEL`, `HARNESS_BASE_URL`, `OPENAI_API_KEY`, `HARNESS_CONFIDENCE_THRESHOLD`.

## Models

- **Ollama**: `ollama/qwen3:8b` (default, runs locally via `http://localhost:11434/v1`)
- **OpenAI**: `openai/gpt-4o-mini`, `openai/gpt-4o`
- **Mock**: pass `--mock` or `"mock": true` — keyword heuristics, no model call

## Tests

```bash
npm test
```

## Architecture

See [docs/architecture.md](docs/architecture.md).
