# Model Specialization Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating model-specialization training data.

Append output to `adapters/model_specialization.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start

A row is one JSON line. Choose the model specialization best suited to the latest user message.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"chat\",\"reason\":\"The request is a general conversational answer.\"}"}]}
```

## Output Contract

```json
{"model_specialization":"chat|writing|reasoning|planning|coding|instruction_following|unclear","reason":"<one sentence>"}
```

- `model_specialization`: exactly one specialization value.
- `reason`: compact diagnostic explanation, under 200 characters.

JSON key order: `model_specialization`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Label Rules

Use `chat` for general answers, explanations, discussion, casual conversation, and lightweight Q&A.

Use `writing` for drafting, rewriting, summarizing, translating, polishing, tone changes, and prose formatting.

Use `reasoning` for analysis, comparison, diagnosis, evaluation, recommendation, tradeoff discussion, and decision support.

Use `planning` for plans, roadmaps, checklists, specs, strategies, sequencing, and project/task decomposition.

Use `coding` for code questions, debugging, repo inspection, tests, implementation, refactors, and code edits.

Use `instruction_following` for precise extraction, classification, conversion, schema filling, rule application, or format compliance where following explicit constraints is the main task.

Use `unclear` when the latest message is too malformed or context-missing to identify a specialization.

## Boundary Rules

Choose the specialization that should drive model selection and prompt specialization, not the execution mode.

Do not use `instruction_following` merely because the user included a constraint. Use it when precise rule/schema compliance is the core task.

Tool use does not imply a specialization by itself. Repo work is usually `coding`; scheduling may be `chat` or `planning` depending on the requested outcome.

When a request mixes modes, choose the specialization for the final intended output or highest-skill part.

If both `reasoning` and another value seem plausible, prefer the more specific non-reasoning value when the task is primarily writing, planning, coding, or instruction compliance.

## Examples

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat is DNS?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"chat\",\"reason\":\"The request is a general explanatory question.\"}"}]}
```

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ndraft a concise reply to Sarah\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"writing\",\"reason\":\"The user wants prose composed for a message.\"}"}]}
```

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare SQLite and Postgres for this app and recommend one\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"reasoning\",\"reason\":\"The request asks for tradeoff analysis and a recommendation.\"}"}]}
```

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nmake a migration checklist for the team\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"planning\",\"reason\":\"The request asks for an actionable checklist.\"}"}]}
```

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nfind and fix the failing upload test in this repo\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"coding\",\"reason\":\"The request requires codebase debugging and changes.\"}"}]}
```

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nextract the invoice number, vendor, and total as JSON only\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"instruction_following\",\"reason\":\"The main task is structured extraction with strict output constraints.\"}"}]}
```

## Generation Mix

Per 100 records, target roughly:

- 15-20 `chat`
- 15-20 `writing`
- 20-25 `reasoning`
- 10-15 `planning`
- 15-20 `coding`
- 10-15 `instruction_following`
- 3-5 `unclear`

Include boundary pairs where similar messages flip because the core model specialization changes.

## Self-Check

Before emitting a row:

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly two keys: `model_specialization` and `reason`.
3. The specialization is the best model/prompt specialization, not simply the tool family or execution mode.
4. `reason` is short, factual, and consistent with the label.
5. The user message is not a near-duplicate of any prior row in this batch.
