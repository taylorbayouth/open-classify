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
  },
  "server": {
    "max_body_bytes": 1048576
  }
}
```

All settings:

| Section            | Key                          | Default | Env var                            | Notes |
|--------------------|------------------------------|---------|------------------------------------|-------|
| `classifiers.<dim>`| `model`                      | `ollama/gemma4:e4b-it-q4_K_M` | `HARNESS_MODEL` (applies to all 5) | `<provider>/<name>`; provider defaults to `ollama` |
| `classifiers.<dim>`| `timeout_ms`                 | `15000` | `HARNESS_TIMEOUT_MS` (all 5)       | Per-call hard timeout |
| `classifiers.<dim>`| `base_url`                   | `http://localhost:11434/v1` | `HARNESS_BASE_URL` (all 5)         | Ollama endpoint; ignored for non-Ollama providers |
| `classifiers.<dim>`| `api_key`                    | —       | `OPENAI_API_KEY` (all 5)           | Used by the OpenAI client |
| `classifiers.<dim>`| `prompt`                     | —       | (file only — multi-line)           | Optional. Full prompt override; must instruct the model to return JSON matching the schema |
| `routing`          | `avg_confidence_threshold`   | `0.65`  | `HARNESS_AVG_CONFIDENCE_THRESHOLD` | Below this avg → UI override |
| `routing`          | `min_confidence_threshold`   | `0.4`   | `HARNESS_MIN_CONFIDENCE_THRESHOLD` | Per-classifier floor |
| `server`           | `max_body_bytes`             | `1048576` (1 MiB) | `HARNESS_MAX_BODY_BYTES`           | HTTP-only DoS guard. Server returns 413 above this. CLI and direct `classify()` callers are uncapped. |

Resolution order (last wins): built-in defaults → `harness.config.json` → `harness.config.local.json` → env vars.

### Input handling

All `user_input` strings — regardless of entry point (HTTP, CLI, direct API) — are sanitized at the schema layer before any classifier sees them. Sanitization is **non-destructive**: it never changes the semantic content of the message.

1. Strip a leading byte-order mark (U+FEFF).
2. Unicode NFC normalization (composed form).
3. Strip ASCII control chars except `\t`, `\n`, `\r`.
4. Trim outer whitespace.
5. Reject if empty after the above.

There is **no upper length bound** at the library level. If you want to classify a long document, that's your call — the model's context window is the eventual ceiling. The HTTP server's `max_body_bytes` is a separate, deployment-level guard that only applies when running `npm run server`.

## Models

- **Ollama**: `ollama/qwen3:8b`, `ollama/gemma2:9b`, etc.
- **OpenAI**: `openai/gpt-4o-mini`, `openai/gpt-4o`

## Add or modify a classifier

Every classifier lives in [`src/classifiers.ts`](src/classifiers.ts) — that one file is the registry. Each entry holds a Zod schema, a prompt, and (optionally) a list of enum values for the UI's option pills. Everything else (config defaults, env-var overrides, NDJSON streaming, traces, the live web UI) iterates over the registry and picks up changes automatically.

- **Edit an enum value or its description.** Edit the `options({...})` map for that dimension. The Zod enum, the bullet list shown to the model, and the UI's option pills are all derived from that single map — they cannot drift.
- **Edit a prompt.** Edit the `prompt` template literal on that classifier's entry. `${X.list}` interpolations splice in the current enum values automatically.
- **Add a new classifier.** Add an entry to `CLASSIFIERS` with a schema, prompt, and (optionally) `displayOptions`. That's it — no other file needs to change.
- **Remove a classifier.** Delete its entry.
- **Override a prompt without touching source.** Set `classifiers.<dim>.prompt` in `harness.config.json`. The override is a full string replacement; it must still instruct the model to return JSON matching the schema.

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
