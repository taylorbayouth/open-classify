# Preflight Training Guide

Use this guide when adding rows to `adapters/preflight.jsonl`.

## What We Are Fine Tuning For

Preflight is a small gate in front of the rest of the system. It stops the pipeline only when a 1–5 word `reply` written from the message alone is the complete assistant response. Otherwise it routes onward.

The behavior is conservative:

- Be quick and human.
- Keep `reply` short, usually 1 to 5 words.
- Use `terminal` only when the `reply` is the complete answer.
- Use `continue` when there is any substantive task, hidden context, or external need.
- Use `unable_to_determine` only for messages too unclear to classify confidently.

## Output Contract

```json
{"terminality":"terminal|continue|unable_to_determine","reply":"<short user-facing line>"}
```

## The Discriminator

A single test decides terminality:

> Can a 1–5 word reply, written from the message alone, fully serve as the assistant's complete answer?

- **Yes** → `reply` is in **answer mode** → label `terminal`.
- **No**, because the answer would not fit in a short reply, or because answering needs context, data, tools, or memory → `reply` is in **placeholder mode** → label `continue`.
- **Too unclear** to apply the test → label `unable_to_determine` (`reply` is still a placeholder).

When in doubt, prefer `continue`. The cost of routing a terminal-able message is one wasted classifier pass; the cost of stopping a substantive request is a wrong answer.

## The Two Reply Modes

The `reply` field has two unrelated jobs depending on terminality. Training rows must honor both:

| Mode | Used when | What `reply` should be |
|------|-----------|------------------------|
| Answer | `terminal` | The actual final response (e.g. "Hi.", "56.", "Paris.") |
| Placeholder | `continue`, `unable_to_determine` | A brief acknowledgement that does not answer (e.g. "I'll check.", "Let me check.") |

The field was renamed from `awk` to `reply` to avoid biasing the model toward acknowledgement-shaped output on terminal cases. Training data should reinforce that `reply` on a `terminal` row is the answer itself, not an offer to help.

## Input Shapes by Label

Pick training shapes by what the input *is*, not by the label. The label follows from the shape.

### Terminal — answer mode

- **Phatic / pure social.** Greetings, thanks, goodbyes, well-wishes. The reply is a brief social return.
- **Tiny self-contained question.** Common-knowledge factual recall, simple arithmetic, basic transformations the model can do without external resources.
- **Trivial transformation of the message itself.** "Uppercase X", "spell Y", "respond with exactly Z".
- **Acknowledgement closers.** "Got it", "noted", "no more changes" — the user is closing a loop.

### Continue — placeholder mode

- **Implicit task or action.** "Ship it", "go ahead", "run the migration" — directing real work.
- **Composition or judgment request.** Writing, drafting, analysis, advice. Output exceeds a phrase.
- **Needs context.** "Make that shorter", "fix the bug we discussed" — references prior turn or shared state.
- **Needs lookup, data, or tools.** "What's the weather", "search for X", "open the file".
- **Needs memory.** "Send my usual report", "book the standard hotel".
- **Courtesy + substantive request.** "Thanks, can you also do X" — the request controls; choose `continue`.

### Unable_to_determine — placeholder mode

- **Ambiguous fragment with no resolvable referent.** "That one", "do it like before", "no not that".

## Gotchas

- Bare greetings ("hi", "hey", "yo") are `terminal`, not `continue`. The model often wants to default to "How can I help?" — train against this.
- "Thanks, ship it" is `continue` (courtesy + request), not `terminal`.
- "Oh make that 4 PM!" is `continue`; it implies a prior task.
- "What is 2+2?" is `terminal` because the answer fits in `reply`.
- "What's the weather?" is `continue`; it needs a lookup.
- "What should I do about this error?" is `continue`; it needs judgment.
- Do not let `reply` answer substantive requests on `continue` — that is what downstream is for.
- Do not ask clarification questions in `reply`. "How can I help?" is wrong on every label.
- Do not mention routing, classifiers, tools, or models in `reply`.

## Good `reply` Patterns

- `terminal` (answer mode): "Hello.", "Anytime.", "Got it.", "56.", "Paris.", "Tuesday."
- `continue` (placeholder mode): "I'll check.", "I'll update it.", "Let me check.", "On it."
- `unable_to_determine` (placeholder mode): "Let me check.", "I need context."

## Batch Coverage

For a 100-row batch:

- 40 `continue`
- 40 `terminal`
- 20 `unable_to_determine`

Vary message length and shape inside each label. Include short, long, very long, typo-heavy, contradictory, half-finished, multi-message, and referential messages. Within `terminal`, balance across the four sub-shapes (phatic, tiny Q, trivial transformation, acknowledgement closer). Within `continue`, balance across implicit-task, composition, context-needing, lookup-needing, memory-needing, and courtesy+request.

## Example Rows

Terminal — phatic:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nhi\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"Hi.\"}"}]}
```

Terminal — tiny self-contained question:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat is 9 minus 4?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"5.\"}"}]}
```

Continue — implicit task:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the failing tests and fix the smallest thing causing them\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"I'll check.\"}"}]}
```

Continue — needs lookup:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat's the weather right now?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"Let me check.\"}"}]}
```

Unable to determine — ambiguous fragment:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthat one but cleaner\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"unable_to_determine\",\"reply\":\"I need context.\"}"}]}
```
