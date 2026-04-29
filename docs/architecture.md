# Architecture

## Flow

```
User Input (POST /classify or CLI)
  ↓
Input Envelope (request_id, user_input)
  ↓
5 parallel sub-classifiers (Promise.all)
  ├── task_class
  ├── needs_memory
  ├── tools_required
  ├── suggested_model
  └── security
  ↓
Aggregator merges results, computes avg/min confidence
  ↓
Deterministic Routing Rules
  ↓
Route Decision
  ↓
Trace Emit (SSE broadcast + in-memory store)
```

## The 5 dimensions

| Dimension | Enum |
|-----------|------|
| `task_class` | `chat \| draft \| code \| research \| unknown` |
| `needs_memory` | `none \| recent \| session \| long_term` |
| `tools_required` | `true \| false` |
| `suggested_model` | `local_fast \| local_slow \| billed_mini \| billed_frontier` |
| `security` | `clean \| suspicious \| prompt_injection` |

Each sub-classifier returns its value plus a `confidence` (0–1). The aggregator computes `average_confidence` and `min_confidence` across all 5.

## Routing Rules (priority order)

1. Classifier failed → `fallback` route
2. `security: prompt_injection` → `reject` route, requires_confirmation: true
3. `average_confidence < threshold` OR `min_confidence < min_threshold` → escalate to `billed_frontier` (escalation_reason: `low_confidence`)
4. `security: suspicious` → escalate to `billed_frontier` with confirmation (escalation_reason: `suspicious`)
5. Otherwise → trust `suggested_model` directly

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
| `schema.ts` | Zod schemas for all 5 sub-classifier results, aggregated classification, route decision, trace |
| `config.ts` | Config loading with env var overrides |
| `classify.ts` | 5 parallel sub-classifier calls, aggregation, fallback handling |
| `route.ts` | Deterministic routing rules — pure function of Classification → RouteDecision |
| `trace.ts` | Builds and emits trace objects |
| `server.ts` | HTTP server, SSE broadcast, live UI |
| `cli.ts` | CLI for one-off classification |

## Non-goals (v0)

- Tool execution
- State capsule mutation
- Long-term memory storage
- Autonomous agent behavior
- Calibrated cross-model confidence scores
