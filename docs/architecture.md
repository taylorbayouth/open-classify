# Architecture

## Flow

```
User Input (POST /classify or CLI)
  ↓
Input Envelope (request_id, user_input, optional state_capsule)
  ↓
Classifier (LLM call with strict JSON prompt)
  ↓
Schema Validation (Zod strict parse)
  ↓  [if invalid → retry with repair prompt → fallback]
Deterministic Routing Rules
  ↓
Route Decision
  ↓
Trace Emit (SSE broadcast + in-memory store)
```

## Modules

| File | Responsibility |
|------|---------------|
| `schema.ts` | All types and Zod schemas. Single source of truth. |
| `config.ts` | Config loading with env var overrides and defaults. |
| `classify.ts` | LLM call, JSON extraction, schema validation, retry/fallback, mock classifier. |
| `route.ts` | Deterministic routing rules — pure function of Classification → RouteDecision. |
| `trace.ts` | Builds and emits trace objects. |
| `server.ts` | HTTP server, SSE broadcast, live UI. |
| `cli.ts` | CLI interface for one-off classification. |

## Routing Rules (priority order)

1. Classifier failed → `fallback` route
2. `needs_side_effect_tool` → `confirm_side_effect` (requires_confirmation: true)
3. `risk: high` (no side effect) → `frontier` (requires_confirmation: true)
4. `needs_fresh_info` → `web` route
5. `needs_private_context` → `private_context` route
6. `task_class: research` → `frontier`
7. `task_class: code | planning` → `cheap`
8. Default → `cheap`

## Fallback Ladder

1. First classify attempt with full prompt + `response_format: json_object`
2. If invalid/below confidence threshold → retry with minimal repair prompt
3. If still invalid → `fallback` route, `fallback_used: true` in trace

## Non-goals (v0)

- Tool execution
- State capsule mutation
- Long-term memory
- Autonomous agent behavior
- Multi-agent orchestration
