# Context Sufficiency Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating context-sufficiency training data. Use it with the shared README preamble; this file contains only the context-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/context_sufficiency.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start (Human Curator)

A row is one JSON line. The user message wraps the conversation window; the assistant message is the classifier's JSON output, and nothing else. Pick a context label, add missing-context hints only when something is absent, and summarize only relevant supplied context.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"self_contained\",\"missing_context\":[],\"relevant_context_summary\":\"\"}"}]}
```

## What We Are Fine Tuning For

Context sufficiency answers one question: **is the latest user message understandable with the supplied conversation window?**

It should not decide tools, routing, safety, memory, or whether the assistant should answer. It identifies whether earlier messages are unnecessary, merely helpful, required, still missing, or insufficient because the user points outside the retained window.

The classifier should be conservative about hidden context:

- Use `self_contained` only when prior messages would not materially change routing or response.
- Use `adjacent_context_helpful` when the latest message is understandable but nearby context improves continuity.
- Use `referential` when supplied context is required and sufficient to resolve the latest message.
- Use `incomplete_information` when a required detail is absent from the latest message and absent from the supplied window.
- Use `long_context` when the latest message points beyond the supplied window or into durable project history.
- Use `unable_to_determine` only when the message itself is too malformed, opaque, or contradictory to classify.

## What Failure Costs In Production

- **False self-contained.** Downstream loses relevant context, answers the wrong object, or routes too cheaply. This is the most common bad miss.
- **False referential.** The system may over-focus on prior context and ignore that the latest message already stands alone. Usually a quality hit, not catastrophic.
- **False incomplete/long_context.** Downstream escalates or asks for context unnecessarily. Expensive but safer than confidently dropping context.
- **Over-using `unable_to_determine`.** The request escalates to a bigger model. Safe, but defeats the point of the local classifier.

**Bias the training data accordingly.** When supplied context resolves the latest message, choose `referential`. When context improves quality but is not required, choose `adjacent_context_helpful`. When older/off-window context is invoked, choose `long_context`. Use `unable_to_determine` for unreadable input, not for normal ambiguity.

## Output Contract

```json
{"value":"self_contained|adjacent_context_helpful|referential|incomplete_information|long_context|unable_to_determine","missing_context":["<short_missing_context>"],"relevant_context_summary":"<markdown_summary>"}
```

- `value` (required): exactly one enum value, lowercase, snake_case.
- `missing_context` (required): array of short snake_case hints, at most 5 items. Use `[]` when no material context is missing.
- `relevant_context_summary` (required): concise Markdown string summarizing only supplied earlier conversation information that matters to the latest message. Use `""` when none is needed.

JSON key order: `value`, then `missing_context`, then `relevant_context_summary`. No extra keys. No whitespace inside the assistant JSON.

## Common LLM Failure Modes When Generating Context Data

Watch for these:

1. **Calling every follow-up `referential`.** Some follow-ups are understandable without prior text. "Let's continue with the migration plan" is often `adjacent_context_helpful`; routing and response can proceed even if earlier details would improve quality.
2. **Calling every missing-final-answer case `incomplete_information`.** This classifier is not judging whether the assistant has enough information to produce the final answer. It is judging whether the latest message is understandable with the supplied window.
3. **Confusing `referential` and `long_context`.** If the supplied window contains the thing referred to, use `referential`. If the user invokes older decisions, preferences, prior sessions, or "everything we discussed" outside the window, use `long_context`.
4. **Leaking message indexes into summaries.** Summaries should say "Earlier context includes..." rather than "Message 1 says...".
5. **Stuffing prior text into summaries.** Summarize only the relevant facts. Do not copy long drafts or code blocks.
6. **Output-shape drift.** Lock key order, enum casing, array shape, and compact JSON. Vary only the user message.

## Label Rules

Use `self_contained` when the latest message is understandable by itself and earlier messages would not materially change routing or response.

Use `adjacent_context_helpful` when earlier messages improve continuity, tone, or quality, but the latest message still has a clear standalone intent.

Use `referential` when supplied earlier messages are required to understand what "that", "it", "the draft", "same version", "those numbers", or similar references mean.

Use `incomplete_information` when required details are absent even after reading the supplied window. This often means a missing object, recipient, date, file, event, comparison set, or decision criterion.

Use `long_context` when the latest message invokes older project state, prior decisions, saved preferences, prior sessions, "everything we discussed", "the usual plan", or context beyond the supplied window.

Use `unable_to_determine` when the latest message is too malformed, opaque, contradictory, or corrupted to classify.

## Missing Context And Summary Rules

- `self_contained`: `missing_context` must be `[]`; `relevant_context_summary` must be `""`.
- `adjacent_context_helpful`: `missing_context` is usually `[]`; `relevant_context_summary` may be `""` or a very short supplied-context note when useful.
- `referential`: `missing_context` must be `[]` because the supplied window resolves the reference; `relevant_context_summary` should include the resolving fact.
- `incomplete_information`: include short missing slots such as `event_subject`, `recipient`, `document_text`, `comparison_options`, `target_file`, `deadline`, `approval_scope`.
- `long_context`: include absent older-state hints such as `prior_requirements`, `project_decisions`, `user_preferences`, `earlier_design_direction`, `historical_metrics`.
- `unable_to_determine`: `missing_context` should usually be `[]`; the note belongs in `relevant_context_summary` only if supplied context explains the ambiguity.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes rather than free-generating:

**Surface:** slack DM, email thread, web chat, code review comment, customer support thread, meeting transcript, SMS, mobile push reply, issue tracker comment, voice transcript.

**Conversation shape:** single-message target, one prior context message, two prior messages, assistant answer followed by user edit, old context dropped from retained window, attachment metadata plus referential message.

**Reference type:** pronoun, "that", "it", "the first one", "the safer version", "same as before", "our plan", "everything from last time", "the attached file", "the numbers above".

**Domain:** software engineering, docs/writing, scheduling, product planning, legal review, finance analysis, hiring, travel, personal logistics, support, education, research.

**Register:** terse expert, casual peer, formal, frustrated, voice-to-text, typo-heavy, multilingual code-switching, all-lowercase.

**User personas:** founder, PM, engineer, designer, analyst, lawyer, recruiter, teacher, student, support agent, executive assistant.

**Attachments:** none, PDF metadata, CSV metadata, image metadata, multiple attachments, user mentions an attachment but metadata is `none`.

Generate combinations across these axes. Avoid making every row a simple "make that shorter" example.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 8-12 boundary pairs per batch. Each pair has near-identical surface form but flips one label. Emit paired rows adjacent to sharpen Gemma's boundary.

Example pair shapes (do not copy these inputs verbatim):

- **Self-contained vs referential.** "Make the email shorter" with no prior email needed for routing -> `self_contained`. "Make that shorter" after a supplied draft -> `referential`.
- **Referential vs incomplete.** "Move it to 3 PM" after supplied meeting context -> `referential`. Same target with no meeting context -> `incomplete_information`.
- **Referential vs long_context.** "Use the draft above" when the draft is in window -> `referential`. "Use everything from our last planning session" with no supplied decisions -> `long_context`.
- **Adjacent helpful vs referential.** "Continue the migration plan" after a migration discussion -> `adjacent_context_helpful`. "Use the migration plan above and turn it into tasks" -> `referential`.
- **Incomplete vs unable.** "Schedule it Tuesday" -> `incomplete_information`. "Tuesday but not the other not that" -> `unable_to_determine`.
- **Attachment metadata vs missing attachment.** "Summarize the attached report" with PDF metadata -> `self_contained` for context sufficiency. Same message with `Attachments: none` and no report text -> `incomplete_information`.

## Gotchas

- "Make that shorter" is `referential` if the prior draft is in the window.
- "Make the email shorter" can be `self_contained` for this classifier; final answering may still need an email body, but the latest request is understandable.
- "Let's continue with the migration plan" is often `adjacent_context_helpful`, unless the supplied plan itself is required to understand the requested action.
- "Based on everything we decided last week" is `long_context`, not `referential`, when those decisions are not in the window.
- An attachment can make the request understandable even though content inspection happens elsewhere. For context sufficiency, attached metadata plus "summarize the attached PDF" is not automatically incomplete.
- Do not include missing context for `referential` when the supplied window resolves the reference.
- Do not classify earlier messages as new requests. Only the final message is the target.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Label distribution (per 100):** 25-30 `self_contained`, 15-20 `adjacent_context_helpful`, 20-25 `referential`, 15-20 `incomplete_information`, 10-15 `long_context`, 3-6 `unable_to_determine`.
- **Multi-message windows:** 45-55% of rows. This classifier needs context-rich examples.
- **Attachment metadata:** 10-15% of rows. Include both context-sufficient and incomplete attachment cases.
- **Boundary pairs:** 8-12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly three keys: `value`, `missing_context`, and `relevant_context_summary`.
3. `missing_context` has at most 5 snake_case strings; no duplicates.
4. `relevant_context_summary` is under 1,000 characters and only summarizes supplied earlier context.
5. Label invariants hold: `self_contained` has `[]` and `""`; `referential` has `[]` and a resolving summary; missing slots appear only when actually absent.
6. The user message is not a near-duplicate of any prior row in this batch and not copied from this guide's examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot decide between labels after applying the rules. Skip rather than guess.
- The row relies on context that is not actually present in the rendered `Conversation window:`.
- The user message contains real-world identifiers, secrets, names, or contact details. Use realistic but fictional substitutes.
- The summary would need to quote long proprietary text. Summarize the relevant fact instead.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

Self-contained:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare SQLite and Postgres for a small offline-first app\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"self_contained\",\"missing_context\":[],\"relevant_context_summary\":\"\"}"}]}
```

Adjacent context helpful:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nWe are planning a low-risk migration from a cron job to a small queue worker.\n\nMessage 2 (target):\nrole: user\ntext:\nlet's continue with the migration plan\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"adjacent_context_helpful\",\"missing_context\":[],\"relevant_context_summary\":\"Earlier context says the migration is from a cron job to a small queue worker.\"}"}]}
```

Referential:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nHere is the announcement: We are moving the beta from May to June because QA needs another week.\n\nMessage 2 (target):\nrole: user\ntext:\nmake that warmer and shorter\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"referential\",\"missing_context\":[],\"relevant_context_summary\":\"Earlier context includes an announcement moving the beta from May to June because QA needs another week.\"}"}]}
```

Incomplete information:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nschedule it for Tuesday afternoon\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"incomplete_information\",\"missing_context\":[\"event_subject\"],\"relevant_context_summary\":\"\"}"}]}
```

Long context:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn everything we decided in the last few planning sessions into the final spec\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"long_context\",\"missing_context\":[\"prior_planning_decisions\"],\"relevant_context_summary\":\"\"}"}]}
```

Unable to determine:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nnot that but the no version from before after\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"unable_to_determine\",\"missing_context\":[],\"relevant_context_summary\":\"\"}"}]}
```

Boundary pair -- supplied context resolves vs missing slot:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nThe vendor review meeting is currently on Thursday at 2 PM.\n\nMessage 2 (target):\nrole: user\ntext:\nmove it to Friday morning\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"referential\",\"missing_context\":[],\"relevant_context_summary\":\"Earlier context identifies the vendor review meeting currently scheduled for Thursday at 2 PM.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nmove it to Friday morning\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"value\":\"incomplete_information\",\"missing_context\":[\"event_subject\"],\"relevant_context_summary\":\"\"}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the context sufficiency classifier for an AI assistant handoff system.

Decide whether the latest normalized user message is understandable with the supplied conversation window.

Return ONLY valid JSON matching:
{"value":"self_contained|adjacent_context_helpful|referential|incomplete_information|long_context|unable_to_determine","missing_context":["<short_missing_context>"],"relevant_context_summary":"<markdown_summary>"}

Values:
- "self_contained": choose this when the latest message has enough information to route and respond without earlier messages.
- "adjacent_context_helpful": choose this when earlier messages improve quality or continuity, but the latest message is still understandable without them.
- "referential": choose this when supplied earlier content is required to understand the latest message.
- "incomplete_information": choose this when the latest message is missing required information and the supplied earlier messages do not resolve it.
- "long_context": choose this when the latest message appears to depend on older project state, prior decisions, requirements, preferences, or a long-running conversation beyond the supplied window.
- "unable_to_determine": choose this when the message is too malformed, opaque, or contradictory to classify.

Selection guide:
- Classify only the final/latest message. Earlier messages are context evidence, not new requests.
- Choose "referential" when the supplied window provides required context for the latest message.
- Choose "incomplete_information" when a required slot is still absent after reading the supplied window.
- Choose "long_context" over "referential" when the user invokes older decisions, project state, requirements, preferences, or "everything we discussed".
- Choose "adjacent_context_helpful" when context improves quality but is not required.
- Choose "self_contained" only when earlier messages would not materially change routing or response.
- Use "missing_context" for short snake_case hints about what context is absent. Return [] when no material context is missing.
- "relevant_context_summary" is a concise Markdown string summarizing only supplied earlier conversation information that may be relevant to the latest user query.
- Do not copy, prune, retain, or reference conversation message indexes.
- For "self_contained", return [] for "missing_context" and "" for "relevant_context_summary".

Constraints:
- Return JSON only.
- Choose exactly one value.
- Return at most 5 missing_context items.
- Keep relevant_context_summary under 1,000 characters.
```
