# Context Sufficiency Training Guide

Use this guide when adding rows to `adapters/context_sufficiency.jsonl`.

## What We Are Fine Tuning For

Train context sufficiency to answer one question: is the latest user message understandable with the supplied conversation window?

It should not decide tools, routing, safety, or whether the assistant should answer. It should identify whether earlier messages are unnecessary, helpful, required, missing, or insufficient because the user points outside the window.

## Output Contract

```json
{"value":"self_contained|adjacent_context_helpful|referential|incomplete_information|long_context|unable_to_determine","missing_context":["<short_missing_context>"],"relevant_context_summary":"<markdown_summary>"}
```

## Label Rules

Use `self_contained` when the latest message is understandable by itself and earlier messages would not materially change the response.

Use `adjacent_context_helpful` when earlier messages improve continuity or quality, but the latest message is still understandable without them.

Use `referential` when supplied earlier messages are required to understand the latest message.

Use `incomplete_information` when required details are absent even after reading the supplied window.

Use `long_context` when the latest message invokes older project state, prior decisions, saved preferences, "everything we discussed", or context beyond the supplied window.

Use `unable_to_determine` when the latest message is too malformed, opaque, or contradictory to classify.

## Field Rules

`missing_context` should contain short snake_case hints, at most 5 items. Use `[]` when no material context is missing.

`relevant_context_summary` should summarize only supplied earlier messages that matter to the latest message. Do not mention message numbers. Use `""` for `self_contained`.

## Batch Coverage

For a 100-row batch, include:

- Clear self-contained requests.
- Follow-ups that supplied context resolves.
- Follow-ups where context helps but is not required.
- Missing-slot requests such as "schedule it for Tuesday" with no event.
- Long-context references such as "based on our earlier requirements".
- Broken or contradictory fragments.

Avoid overusing `self_contained`; this classifier must learn the subtle middle cases.

## Gotchas

- "Make that shorter" is `referential` if the prior draft is in the window.
- "Make the email shorter" can be `self_contained` if no actual email content is required to route, but it may still be incomplete for final answering. Label the context need, not tool need.
- "Let's continue with the migration plan" is often `adjacent_context_helpful`, unless the actual plan is necessary and absent.
- "Based on everything we decided last week" is `long_context`, not `referential`, if those decisions are not in the window.
- Do not copy long prior text into `relevant_context_summary`; summarize it.
- Do not include missing context for `referential` when the supplied window resolves the reference.

## Example Rows

Self-contained:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare SQLite and Postgres for a small offline-first app\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"self_contained\",\"missing_context\":[],\"relevant_context_summary\":\"\"}"}]}
```

Referential:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nHere is the announcement: We are moving the beta from May to June because QA needs another week.\n\nMessage 2 (target):\nrole: user\ntext:\nmake that warmer and shorter\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"referential\",\"missing_context\":[],\"relevant_context_summary\":\"Earlier context includes an announcement about moving the beta from May to June because QA needs another week.\"}"}]}
```

Incomplete information:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nschedule it for Tuesday afternoon\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"incomplete_information\",\"missing_context\":[\"event_subject\"],\"relevant_context_summary\":\"\"}"}]}
```

Long context:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn everything we decided in the last few planning sessions into the final spec\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"long_context\",\"missing_context\":[\"prior_planning_decisions\"],\"relevant_context_summary\":\"\"}"}]}
```
