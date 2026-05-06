# Memory Retrieval Queries Training Guide

Use this guide when adding rows to `adapters/memory_retrieval_queries.jsonl`.

## What We Are Fine Tuning For

Train this classifier to emit compact saved-memory query hints only when durable user-specific facts would materially help the downstream assistant.

It should not retrieve memory, answer the user, or query for live state. It should be good at saying no: most self-contained, general, current, or tool-dependent requests should return an empty array.

## Output Contract

```json
{"queries":["<query>"]}
```

## Query Rules

Generate queries for durable facts such as:

- User preferences.
- Recurring projects.
- Prior decisions.
- Established workflows.
- Relationships and contact facts.
- Team or client context.
- Writing style preferences.
- "Usual" vendors, locations, templates, or routines.

Return `[]` when the request is self-contained, depends only on supplied conversation context, asks for general knowledge, or needs live tools instead of saved memory.

Queries should target the missing durable fact, not the current task. Use 3 to 10 words per query. Return at most 3 queries.

## Batch Coverage

Create many negative examples. This classifier should not hallucinate memory needs.

For a 100-row batch, a useful target is:

- 60 to 70 rows with `[]`
- 20 to 30 rows with 1 query
- 5 to 10 rows with 2 or 3 queries

Include ambiguous cases where the right answer is still `[]`.

## Gotchas

- A named person alone is not enough. "Email Sarah" might need tools, but not memory unless the request depends on who Sarah is or her preferences.
- "Latest", "check", "look up", and "open the file" usually need tools, not saved memory.
- If supplied context already includes the needed fact, return `[]`.
- "My usual", "like last time", "our agreed plan", and "the client style" are strong memory signals.
- Do not include secrets or sensitive values verbatim in queries.
- Do not generate queries for generic domain knowledge like "Postgres tradeoffs".
- Keep queries short and noun-phrase-like.

## Example Rows

No memory needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain why bread rises when it bakes\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[]}"}]}
```

Memory needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nbook my usual hotel for the NYC trip\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"user preferred NYC hotel\",\"user hotel booking preferences\"]}"}]}
```

Supplied context resolves it:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nMy preferred client update tone is concise, warm, and direct.\n\nMessage 2 (target):\nrole: user\ntext:\nuse my preferred tone for this update\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[]}"}]}
```

Prior decision needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat did we decide for the onboarding checklist?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"onboarding checklist prior decisions\"]}"}]}
```
