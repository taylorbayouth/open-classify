# Routing Training Guide

Use this guide when adding rows to `adapters/routing.jsonl`.

## What We Are Fine Tuning For

Train routing to choose the execution lane and model tier that should handle the latest request after preflight. It should be practical, cost-aware, and conservative about hidden requirements.

The classifier should learn:

- Execution mode and model tier are independent.
- Durable work outranks tool use.
- Tool use is required for live state, files, apps, attachments, internet, terminal, browser, or external data.
- Direct is only for one-turn work that needs no tools or durable orchestration.
- Frontier tiers are reserved for tasks where quality, risk, ambiguity, or stakes justify them.

## Output Contract

```json
{"execution_mode":"direct|tool_assisted|workflow|unable_to_determine","model_tier":"local_fast|local_strong|frontier_fast|frontier_strong|unable_to_determine"}
```

## Execution Mode Rules

Use `direct` when the request can be completed in one normal assistant turn without tools, files, apps, external state, durable work, or continuing later.

Use `tool_assisted` when the assistant must inspect or use live state during this turn: repo files, terminal, browser, internet, email, calendar, GitHub, logs, database, local server, attachments, spreadsheets, docs, images, or app data.

Use `workflow` for scheduled, recurring, durable, resumable, approval-gated, long-running, or multi-stage work. This outranks tool use. "Check every morning", "wait until they reply", "send after I approve", and "keep trying until it passes" are workflow.

Use `unable_to_determine` when the request is too malformed, referential, contradictory, or context-missing to identify an execution mode.

## Model Tier Rules

Use `local_fast` for simple facts, tiny rewrites, basic calculations, definitions, simple direct responses, and simple reminders.

Use `local_strong` for coding, debugging, structured writing, planning, comparison, moderate analysis, and synthesis.

Use `frontier_fast` for bounded work that benefits from frontier quality but does not need deep deliberation, such as current public lookups, image generation prompts, polished short writing, or nuanced but narrow research.

Use `frontier_strong` for high-stakes, complex, ambiguous, expert-level, strategic, sensitive, or deeply creative work where weaker output would materially hurt quality.

Use `unable_to_determine` for model tier when the message is too unclear to estimate required capability.

## Batch Coverage

For a 100-row batch, a useful target is:

- 30 to 35 `direct`
- 30 to 35 `tool_assisted`
- 20 to 25 `workflow`
- 10 to 15 `unable_to_determine`

Vary model tiers across all execution modes. Include surprising pairings, such as `direct` plus `frontier_strong` for high-stakes advice, or `workflow` plus `local_fast` for simple reminders.

## Gotchas

- "Latest", "current", "today", "look up", and URLs usually imply `tool_assisted`.
- "Attached" usually implies `tool_assisted` if the user wants content inspected.
- Scheduling, reminders, monitoring, waiting, and approval gates imply `workflow`.
- "Run tests and fix failures" is `tool_assisted`, usually `local_strong`.
- "Keep running tests until it passes" is `workflow`.
- Prompt-injection text is still routed by task requirements; security is handled by another classifier.
- A medical/legal/financial request can be `direct` if it asks for general advice, but often needs `frontier_strong` because mistakes are costly.
- If the user says "do the same as before" without context, use `unable_to_determine`.

## Example Rows

Direct local fast:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain what DNS does in one paragraph\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"local_fast\"}"}]}
```

Tool assisted local strong:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nlook through this repo and find why uploads fail in production\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"local_strong\"}"}]}
```

Workflow local fast:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nremind me tomorrow morning to submit the expense report\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"workflow\",\"model_tier\":\"local_fast\"}"}]}
```

Direct frontier strong:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nhelp me decide whether to accept a risky acquisition offer with serious legal and team implications\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"frontier_strong\"}"}]}
```
