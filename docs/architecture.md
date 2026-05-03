# Architecture

## Flow

```
User Input (POST /classify or CLI)
  ↓
Input Envelope (request_id, user_input)
  ↓
5 parallel sub-classifiers (Promise.all)
  ├── awk
  ├── response_path
  ├── context_budget
  ├── retrieval_need
  └── work_complexity
  ↓
Trace Emit (NDJSON stream + in-memory store)
```

## The 5 dimensions

| Dimension | Shape |
|-----------|-------|
| `awk` | `{ text: string (≤280), mode: "only" \| "first" \| "question", should_send: bool, confidence: 0–1 }` |
| `response_path` | `none \| small_model \| large_model \| tool_assisted \| workflow` |
| `context_budget` | `none \| current_message_only \| last_exchange \| recent_context \| retrieved_context_only \| full_conversation` |
| `retrieval_need` | array of `none \| memory \| files \| web \| browser \| email_calendar \| system_local_state \| other` |
| `work_complexity` | `trivial \| simple \| moderate \| complex \| multi_step` |

Every result also carries a `confidence` (0–1).

## Confidence thresholds

There is no router. Two thresholds in `routing` (`avg_confidence_threshold`, `min_confidence_threshold`) drive a UI-side override: when the average confidence across the 5 classifiers, or any single classifier's confidence, falls below threshold, the surface forces `awk.mode = "question"` and `response_path = "none"` rather than acting on a low-confidence read. The classifier output itself is never rewritten — the override is a display/dispatch concern.

## Why parallel?

The original single-prompt classifier (asking 7 questions in one call) had two problems:

1. **Moralizing**: when asked to evaluate risk + classify simultaneously, small models refuse adversarial inputs instead of classifying them
2. **Confused fields**: harder for the model to keep field semantics straight

Splitting into 5 narrow questions:
- Each prompt is single-purpose (no opportunity to confuse fields)
- The model can't moralize on "what type of task is this?" the way it can on "how risky is this?"
- Per-classifier confidence is more meaningful than a single overall confidence

Wall-clock latency is bounded by the *slowest* call, not the sum — provided the backend supports concurrent requests.

## Ollama concurrency

Ollama defaults to `OLLAMA_NUM_PARALLEL=1`. With that setting, the 5 parallel calls queue serially and total latency = 5x single-call latency.

Run Ollama with parallelism enabled:
```bash
OLLAMA_NUM_PARALLEL=5 ollama serve
```

## Modules

| File | Responsibility |
|------|----------------|
| `schema.ts` | Zod schemas for all 5 sub-classifier results, sub-result record, and trace |
| `config.ts` | Per-classifier config loading with env var overrides |
| `classify.ts` | 5 parallel sub-classifier calls; emits per-dimension events |
| `trace.ts` | Builds and emits trace objects |
| `server.ts` | HTTP server, NDJSON streaming, live UI |
| `cli.ts` | CLI for one-off classification |

## Non-goals (v0)

- Tool execution
- State capsule mutation
- Long-term memory storage
- Autonomous agent behavior
- Calibrated cross-model confidence scores
