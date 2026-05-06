# Memory Retrieval Queries Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating memory-retrieval-query training data. Use it with the shared README preamble; this file contains only the memory-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/memory_retrieval_queries.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start (Human Curator)

A row is one JSON line. Emit short saved-memory query hints when searchable context could materially help downstream. Use an empty array only when prior-context search is unlikely to add value.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[],\"reason\":\"No saved-memory search is likely to improve this request.\"}"}]}
```

## What We Are Fine Tuning For

This classifier plans **saved-memory query hints**. It does not retrieve memory, answer the user, choose tools, or decide model tier.

It should emit compact query hints when saved memory or prior context could help the downstream assistant answer with richer, more consistent context.

It must be excellent at choosing useful retrieval surfaces:

- General knowledge requests do not need memory.
- Current/live data requests need tools, not memory.
- Self-contained transformations usually do not need memory.
- Names, companies, projects, artifacts, distinctive phrases, stable preferences, prior decisions, routines, relationships, and "usual" patterns are useful memory signals.
- Supplied conversation facts can still provide good query terms when related saved context would help the downstream answer.

## What Failure Costs In Production

- **False positive memory query.** The downstream assistant fetches irrelevant saved memory, adding latency and possible privacy surface.
- **False negative memory query.** The downstream assistant answers without useful context, missing the user's preferences, prior decisions, contacts, recurring workflow, or related history. Quality suffers.
- **Over-specific query.** The memory search misses relevant facts because the hint copied too much of the current wording instead of targeting searchable terms.
- **Leaking sensitive values.** Queries should ask for a category of durable fact, not repeat secrets, addresses, tokens, or personal data verbatim.

**Bias the training data accordingly.** Lean toward emitting 1-3 useful query hints when the request contains searchable context that could improve the downstream answer. Use `[]` only when memory or prior-context search is unlikely to add value.

## Output Contract

```json
{"queries":["<query>"],"reason":"<one sentence>"}
```

- `queries` (required): array of 0-3 strings.
- `reason` (required): compact diagnostic explanation for why queries are or are not useful, under 200 characters.
- Always emit a `queries` array; use `[]` when there are no useful query hints.
- Do not emit `null` for `queries` or for the assistant JSON.
- Each query must be 3-10 words.
- Query strings should be short noun phrases, not questions, commands, URLs, or full sentences.
- No duplicate queries. No secrets or sensitive values verbatim.

JSON key order: `queries`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Common LLM Failure Modes When Generating Memory Data

Watch for these:

1. **Treating every name as equally useful.** Names are useful query terms when related context could improve the answer, but not when the task is purely mechanical.
2. **Querying memory for live state.** "Latest", "today", "check", "search", "open", "current price", and "what's in this file" usually point to tools, not saved memory.
3. **Ignoring useful supplied context.** The conversation window can contain names, phrases, or decisions that make strong query hints.
4. **Targeting the task instead of the retrieval surface.** Bad: "write the final response". Good: "user client update writing style".
5. **Over-querying.** Do not emit three queries when one clear query is enough.
6. **Output-shape drift.** Lock the single-key JSON shape. Vary only the user message and query strings.

## Query Rules

Generate queries for searchable contextual signals such as:

- User preferences and defaults.
- Recurring projects, clients, vendors, locations, or routines.
- Prior decisions, requirements, and established plans.
- Established workflows, templates, and approval rules.
- Relationships, contact facts, roles, and team/client context.
- Writing style preferences and "how I usually do X" facts.
- Personal logistics that are stable enough to save, such as usual airport, hotel, time zone, or calendar conventions.
- Specific names, project labels, artifacts, and distinctive phrases that could retrieve related history.

Return `[]` when the request is self-contained, asks for general knowledge, needs live tools instead of saved memory, or contains no useful searchable context.

Queries should target useful retrieval surfaces, not merely restate the current task. Use broad but concrete noun phrases.

## Decision Tests

Ask these in order:

1. Could saved memory or prior context materially improve the downstream answer?
2. Does the request or conversation window contain searchable terms that could retrieve that context?
3. Is the useful context something memory could contain, rather than current/live data?
4. Can the query hint be expressed as a 3-10 word noun phrase?

Only emit queries when all four answers are yes. Otherwise return `[]`.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes:

**Memory signal:** "my usual", "same client", "our agreed plan", "the style I like", "last time", "preferred", "the vendor we use", "the team's norm", "how I file these", "the standard template".

**Negative signal:** general fact, current lookup, attached file, repo inspection, one-off writing, generic code question, named person without needed memory, supplied context already resolves it, sensitive value pasted inline.

**Durable fact type:** preference, contact detail, relationship, project history, prior decision, routine, template, writing style, travel preference, team convention, client context.

**Surface:** email, Slack, calendar-related message, travel request, code/project chat, customer-support workflow, personal assistant request, sales update, recruiter note, mobile voice transcript.

**Register:** terse, casual, formal, typo-heavy, multilingual fragment, voice-to-text run-on, executive shorthand.

**User personas:** founder, engineer, PM, sales rep, recruiter, lawyer, consultant, parent, executive assistant, support lead.

**Multi-message windows:** 20-30% of rows. Include cases where supplied context contributes useful query terms.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 8-12 boundary pairs per batch. Each pair has near-identical wording but changes whether memory query hints are useful.

Example pair shapes (do not copy these inputs verbatim):

- **Mechanical task vs contextual task.** "Email Jordan that I am late" -> usually `[]`. "Email Jordan in the tone she prefers from me" -> query for Jordan/user relationship and tone.
- **Current data vs durable preference.** "Find a hotel near the venue" -> `[]` (tools). "Book my usual hotel near the venue" -> hotel preference queries.
- **Supplied context as query surface.** Prior message names a project, client, or decision; target refers back to it -> query using those searchable terms when related history could help.
- **General project vs prior decisions.** "Draft an onboarding checklist" -> `[]`. "What did we decide for the onboarding checklist" -> prior decision query.
- **Generic style vs saved user style.** "Make this more concise" -> `[]`. "Make this sound like my normal investor update" -> saved writing style queries.
- **Tool need vs memory need.** "Open my calendar and find free time" -> `[]`. "Use my usual meeting buffer when scheduling this" -> meeting preference query.

## Gotchas

- A named person is a possible query term, but only use it when related context could improve the answer.
- "Latest", "check", "look up", "search", "open the file", and "current" usually need tools, not saved memory.
- If supplied context includes specific language that could retrieve related history, use it in a query hint.
- "My usual", "like last time", "our agreed plan", "the client style", and "preferred" are strong memory signals.
- Do not include secrets or sensitive values verbatim in queries.
- Do not generate queries for generic domain knowledge like "Postgres tradeoffs".
- Keep queries short, lowercase-ish, noun-phrase-like, and specific enough for retrieval.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Query-count distribution (per 100):** 30-40 rows with `[]`, 40-50 rows with 1 query, 10-20 rows with 2 or 3 queries.
- **Negative examples:** at least 15 no-memory rows should contain tempting cues where memory would still not add value, especially purely mechanical tasks, live lookups, tools, or generic knowledge.
- **Positive examples:** cover all query signal types listed above.
- **Multi-message windows:** 20-30% of rows, including supplied-context-as-query-surface positives.
- **Boundary pairs:** 8-12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly two keys: `queries` and `reason`.
3. `queries` contains 0-3 unique strings; each string is 3-10 words.
4. Each non-empty query targets a useful searchable context surface.
5. No query includes a secret, token, private address, phone number, or other sensitive value verbatim.
6. `reason` is short, factual, and consistent with the query decision.
7. The user message is not a near-duplicate of any prior row in this batch and not copied from this guide's examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot identify any useful searchable context after applying the decision tests. Skip rather than guess.
- The query would need to include real secrets, personal contact details, or identifiers. Generalize the query.
- The row depends on live state but you are tempted to make it a memory query. Use `[]`.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

No memory needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain why bread rises when it bakes\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[],\"reason\":\"No saved-memory search is likely to improve this request.\"}"}]}
```

Memory needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nbook my usual hotel for the NYC trip\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"user preferred NYC hotel\",\"user hotel booking preferences\"],\"reason\":\"Saved-memory search could provide useful user or project context.\"}"}]}
```

Supplied context resolves it:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nMy preferred client update tone is concise, warm, and direct.\n\nMessage 2 (target):\nrole: user\ntext:\nuse my preferred tone for this update\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[],\"reason\":\"No saved-memory search is likely to improve this request.\"}"}]}
```

Prior decision needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat did we decide for the onboarding checklist?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"onboarding checklist prior decisions\"],\"reason\":\"Saved-memory search could provide useful user or project context.\"}"}]}
```

Boundary pair -- named person no memory vs preference needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsend Priya a note that I will be ten minutes late\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[],\"reason\":\"No saved-memory search is likely to improve this request.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsend Priya the kind of apology note she prefers when I am running late\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"Priya communication preferences\",\"user Priya relationship context\"],\"reason\":\"Saved-memory search could provide useful user or project context.\"}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the saved-memory query hint planner for an AI assistant handoff system.

Generate short query hints the downstream assistant can use to search saved memory or prior context before answering.

Return ONLY valid JSON matching:
{"queries":["<query>"],"reason":"<one sentence>"}

Query semantics:
- Open Classify does not fetch memory; it only emits possible search query hints.
- Query hints are searchable keywords, phrases, names, project labels, prior decisions, preferences, workflows, or specific language that could surface contextual data useful to the downstream assistant.
- Prefer emitting query hints when prior context could make the answer richer, more consistent with the user, or better grounded.
- Return an empty array only when no saved-memory or prior-context search is likely to help, such as self-contained transformations, general knowledge, or requests that only need live tools.

Selection guide:
- Classify only the final user message; earlier messages are context only.
- Generate queries from specific references in the final message and useful context from the conversation window.
- Include names, projects, accounts, artifacts, preferences, prior decisions, recurring workflows, and distinctive phrases when they could retrieve helpful context.
- Target useful retrieval surfaces, not a full restatement of the task. Good queries look like "user client update writing style" or "launch checklist prior decisions".
- When the supplied conversation window contains enough to answer directly, still emit query hints if related saved context could improve the downstream response.
- When both memory and tools may help, emit memory query hints for the contextual part and leave live facts to tools.

Constraints:
- Return JSON only.
- Always return a "queries" array; use [] when there are no useful query hints.
- Do not return null for "queries" or for the classifier result.
- Return at most 3 queries.
- Each query should be 3 to 10 words.
- Do not answer the user.
- Do not include secrets or sensitive content verbatim.
```
