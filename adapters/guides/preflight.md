# Preflight Training Guide

Use this guide when adding rows to `adapters/preflight.jsonl`.

## What We Are Fine Tuning For

Train preflight to be a very small gate in front of the rest of the system. It should stop only when the `reply` line fully satisfies the user. It should route onward for anything that needs real work, tools, context, memory, judgment, or a stronger model.

The desired behavior is conservative:

- Be quick and human.
- Keep `reply` short, usually 1 to 5 words.
- Use `terminal` only when the response is 100 percent complete.
- Use `continue` when there is any substantive task or hint of hidden context.
- Use `unable_to_determine` only for messages too unclear to classify confidently.

## Output Contract

```json
{"terminality":"terminal|continue|unable_to_determine","reply":"<short user-facing line>"}
```

## Label Rules

Use `terminal` when `reply` is the complete final answer. Good terminal cases include greetings, thanks, goodbye, tiny arithmetic, exact repetition, trivial transformations, and explicit "say only X" prompts.

Use `continue` when the user asks for information, writing, editing, planning, coding, tool use, memory lookup, file handling, decisions, scheduling, or any action. If the message includes both courtesy and a request, choose `continue`.

Use `unable_to_determine` when the message is fragmentary or opaque and there is no supplied context that makes it classifiable. Examples: "that one", "do it like before", "the other file", "no not that".

## Batch Coverage

For a 100-row batch, a useful target is:

- 40 `continue`
- 40 `terminal`
- 20 `unable_to_determine`

Vary message length and shape. Include short, long, very long, typo-heavy, contradictory, half-finished, multi-message, and referential messages.

## Gotchas

- "Oh make that 4 PM!" should not be `terminal`; it implies an existing task and should usually be `continue`.
- "Thanks, ship it" is `continue`, not `terminal`.
- "What is 2+2?" can be `terminal` because `reply` can fully answer it.
- "What should I do about this error?" is `continue`; it needs real assistance.
- Do not let `reply` answer substantive requests on `continue`.
- Do not ask clarification questions in `reply`; use a short acknowledgement.
- Do not mention routing, classifiers, tools, or models.

## Good `reply` Patterns

- `terminal`: "Hello.", "Anytime.", "7.", "OK"
- `continue`: "I'll check.", "I'll update it.", "Let me check."
- `unable_to_determine`: "Let me check.", "I need context."

## Example Rows

Terminal:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat is 9 minus 4?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"5.\"}"}]}
```

Continue:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the failing tests and fix the smallest thing causing them\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"I'll check.\"}"}]}
```

Unable to determine:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthat one but cleaner\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"unable_to_determine\",\"reply\":\"I need context.\"}"}]}
```
