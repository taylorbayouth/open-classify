# Conversation History Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating conversation-history training data.

Append output to `adapters/conversation_history.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start

A row is one JSON line. The user message wraps the conversation window; the assistant message is the classifier's JSON output, and nothing else.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":true,\"refers_to_history\":false,\"prior_messages_needed\":0,\"needs_unseen_history\":false,\"reason\":\"The latest message can be handled without prior messages.\"}"}]}
```

## Output Contract

```json
{"is_standalone":true,"refers_to_history":false,"prior_messages_needed":0,"needs_unseen_history":false,"reason":"<one sentence>"}
```

- `is_standalone`: true when the latest message can be routed and answered well without any prior visible messages.
- `refers_to_history`: true when the latest message points to earlier conversation content.
- `prior_messages_needed`: number of visible prior messages to include, excluding the latest message. Use the smallest sufficient recent suffix, but err high when uncertain.
- `needs_unseen_history`: true when useful or required context appears to be outside the supplied window, stripped, omitted, in saved memory, in another thread, or in older project history.
- `reason`: compact one-sentence explanation, under 200 characters.

JSON key order: `is_standalone`, `refers_to_history`, `prior_messages_needed`, `needs_unseen_history`, `reason`. No extra keys. No whitespace inside the assistant JSON.

## Label Rules

Use `is_standalone:true` only when prior messages would not materially change routing or the downstream response.

Use `refers_to_history:true` when the latest message contains references like "that", "it", "the second one", "the above", "same as before", "continue", "our plan", or similar.

Set `prior_messages_needed` to the smallest number of visible prior messages that should be included. If a prior assistant answer and the user message before it are both needed, count both.

Set `needs_unseen_history:true` when the latest message invokes unavailable context: older decisions, saved preferences, usual workflows, earlier sessions, "everything we discussed", or a stripped/omitted long message.

If the latest message is malformed or too opaque to classify, set `is_standalone:false`, include all visible prior messages that may help, and set `needs_unseen_history:true`.

## Boundary Examples

- "Compare SQLite and Postgres for an offline-first app" -> standalone, `prior_messages_needed:0`.
- Earlier draft followed by "Make that shorter" -> not standalone, refers to history, `prior_messages_needed:1`.
- Two options plus assistant recommendation followed by "Use the second one" -> not standalone, refers to history, usually `prior_messages_needed:2` or more.
- Single message "Continue with the migration plan" -> not standalone, refers to history, `prior_messages_needed:0`, `needs_unseen_history:true`.
- Visible migration plan followed by "Continue with this and turn it into tasks" -> not standalone, refers to history, include the visible plan messages.
- "Book my usual hotel" -> not standalone, may not refer to visible history, `needs_unseen_history:true`.

## Generation Mix

Per 100 records, target roughly:

- 30-35 standalone requests.
- 25-30 visible-history references.
- 15-20 unseen-history-needed requests.
- 10-15 ambiguous or malformed boundary cases.
- 10-15 attachment or tool-adjacent requests where history is not the deciding factor.

Use multi-message windows for at least half of the batch. Include boundary pairs where the same surface form flips because visible history is present or absent.
