# Memory Retrieval Queries Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating memory-retrieval-query training data. Use it with the shared README preamble; this file contains only the memory-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/memory_retrieval_queries.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start (Human Curator)

A row is one JSON line. Emit short saved-memory query hints only when durable user-specific facts would materially help downstream. Most rows should return an empty array.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[]}"}]}
```

## What We Are Fine Tuning For

This classifier plans **saved-memory query hints**. It does not retrieve memory, answer the user, choose tools, or decide model tier.

It should emit compact queries only when durable user-specific facts are likely useful enough for the downstream assistant to consider fetching memory before answering.

It must be excellent at saying no:

- General knowledge requests do not need memory.
- Current/live data requests need tools, not memory.
- Supplied conversation facts do not need memory.
- A named person, company, or project is not enough by itself.
- Stable user preferences, prior decisions, routines, relationships, and "usual" patterns are memory signals.

## What Failure Costs In Production

- **False positive memory query.** The downstream assistant fetches irrelevant saved memory, adding latency and possible privacy surface. Too many false positives make local routing expensive.
- **False negative memory query.** The downstream assistant answers without durable user context, missing the user's preferences, prior decisions, contacts, or recurring workflow. Quality suffers.
- **Over-specific query.** The memory search misses relevant facts because the hint copied the current wording instead of targeting the durable fact.
- **Leaking sensitive values.** Queries should ask for a category of durable fact, not repeat secrets, addresses, tokens, or personal data verbatim.

**Bias the training data accordingly.** Prefer `[]` unless a durable saved fact is genuinely useful. When a memory signal is real, emit 1-3 broad noun-phrase queries that target the missing stable fact.

## Output Contract

```json
{"queries":["<query>"]}
```

- `queries` (required): array of 0-3 strings.
- Each query must be 3-10 words.
- Query strings should be short noun phrases, not questions, commands, URLs, or full sentences.
- No duplicate queries. No secrets or sensitive values verbatim.

JSON key order: `queries` only. No extra keys. No whitespace inside the assistant JSON.

## Common LLM Failure Modes When Generating Memory Data

Watch for these:

1. **Treating names as automatic memory needs.** "Email Sarah" needs communications tools, not memory, unless the request depends on who Sarah is, her address, or her preferences.
2. **Querying memory for live state.** "Latest", "today", "check", "search", "open", "current price", and "what's in this file" usually point to tools, not saved memory.
3. **Ignoring supplied context.** If the window already says the user's preferred tone, vendor, client, or deadline, return `[]`.
4. **Targeting the task instead of the missing durable fact.** Bad: "book hotel nyc trip". Good: "user preferred NYC hotel".
5. **Over-querying.** Do not emit three queries when one clear query is enough.
6. **Output-shape drift.** Lock the single-key JSON shape. Vary only the user message and query strings.

## Query Rules

Generate queries for durable facts such as:

- User preferences and defaults.
- Recurring projects, clients, vendors, locations, or routines.
- Prior decisions, requirements, and established plans.
- Established workflows, templates, and approval rules.
- Relationships, contact facts, roles, and team/client context.
- Writing style preferences and "how I usually do X" facts.
- Personal logistics that are stable enough to save, such as usual airport, hotel, time zone, or calendar conventions.

Return `[]` when the request is self-contained, depends only on supplied conversation context, asks for general knowledge, needs live tools instead of saved memory, or mentions a named entity without requiring saved facts about it.

Queries should target the missing durable fact, not the current task. Use broad but concrete noun phrases.

## Decision Tests

Ask these in order:

1. Would saved user-specific memory materially improve the downstream answer?
2. Is the needed fact durable rather than current/live?
3. Is the needed fact absent from the supplied conversation window?
4. Can the missing fact be expressed as a 3-10 word noun phrase?

Only emit queries when all four answers are yes. Otherwise return `[]`.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes:

**Memory signal:** "my usual", "same client", "our agreed plan", "the style I like", "last time", "preferred", "the vendor we use", "the team's norm", "how I file these", "the standard template".

**Negative signal:** general fact, current lookup, attached file, repo inspection, one-off writing, generic code question, named person without needed memory, supplied context already resolves it, sensitive value pasted inline.

**Durable fact type:** preference, contact detail, relationship, project history, prior decision, routine, template, writing style, travel preference, team convention, client context.

**Surface:** email, Slack, calendar-related message, travel request, code/project chat, customer-support workflow, personal assistant request, sales update, recruiter note, mobile voice transcript.

**Register:** terse, casual, formal, typo-heavy, multilingual fragment, voice-to-text run-on, executive shorthand.

**User personas:** founder, engineer, PM, sales rep, recruiter, lawyer, consultant, parent, executive assistant, support lead.

**Multi-message windows:** 20-30% of rows. Include context-resolves-memory cases where the right answer is `[]`.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 8-12 boundary pairs per batch. Each pair has near-identical wording but flips between `[]` and queries.

Example pair shapes (do not copy these inputs verbatim):

- **Named person no memory vs relationship needed.** "Email Jordan that I am late" -> `[]`. "Email Jordan in the tone she prefers from me" -> query for Jordan/user relationship and tone.
- **Current data vs durable preference.** "Find a hotel near the venue" -> `[]` (tools). "Book my usual hotel near the venue" -> hotel preference queries.
- **Supplied context vs absent memory.** Prior message says "our client tone is concise and warm"; target says "use our client tone" -> `[]`. Same target without prior context -> writing preference query.
- **General project vs prior decisions.** "Draft an onboarding checklist" -> `[]`. "What did we decide for the onboarding checklist" -> prior decision query.
- **Generic style vs saved user style.** "Make this more concise" -> `[]`. "Make this sound like my normal investor update" -> saved writing style queries.
- **Tool need vs memory need.** "Open my calendar and find free time" -> `[]`. "Use my usual meeting buffer when scheduling this" -> meeting preference query.

## Gotchas

- A named person alone is not enough. "Email Sarah" may need communications tools, but not memory unless the request depends on Sarah's identity, contact details, or preferences.
- "Latest", "check", "look up", "search", "open the file", and "current" usually need tools, not saved memory.
- If supplied context already includes the needed fact, return `[]`.
- "My usual", "like last time", "our agreed plan", "the client style", and "preferred" are strong memory signals.
- Do not include secrets or sensitive values verbatim in queries.
- Do not generate queries for generic domain knowledge like "Postgres tradeoffs".
- Keep queries short, lowercase-ish, noun-phrase-like, and specific enough for retrieval.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Query-count distribution (per 100):** 60-70 rows with `[]`, 20-30 rows with 1 query, 5-10 rows with 2 or 3 queries.
- **Negative examples:** at least 25 no-memory rows should contain tempting false-positive cues such as names, projects, files, live lookups, tools, or supplied context.
- **Positive examples:** cover all durable fact types listed above.
- **Multi-message windows:** 20-30% of rows, including context-resolves-memory negatives.
- **Boundary pairs:** 8-12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly one key: `queries`.
3. `queries` contains 0-3 unique strings; each string is 3-10 words.
4. Each non-empty query targets a durable user-specific fact absent from the supplied window.
5. No query includes a secret, token, private address, phone number, or other sensitive value verbatim.
6. The user message is not a near-duplicate of any prior row in this batch and not copied from this guide's examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot tell whether memory is materially useful after applying the decision tests. Skip rather than guess.
- The query would need to include real secrets, personal contact details, or identifiers. Generalize the query.
- The row depends on live state but you are tempted to make it a memory query. Use `[]`.
- The supplied context already resolves the missing fact but the output still contains queries. Fix or skip.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

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

Boundary pair -- named person no memory vs preference needed:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsend Priya a note that I will be ten minutes late\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[]}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsend Priya the kind of apology note she prefers when I am running late\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"queries\":[\"Priya communication preferences\",\"user Priya relationship context\"]}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the saved-memory query hint planner for an AI assistant handoff system.

Decide whether the downstream assistant is likely to need saved memory, and generate short query hints it can use to fetch concrete durable facts that are absent from the supplied conversation window.

Return ONLY valid JSON matching:
{"queries":["<query>"]}

Query semantics:
- Use queries for durable user-specific facts such as identities, relationships, preferences, recurring projects, prior decisions, saved context, contact details, account names, or established workflows.
- Generate queries when saved memory is likely useful enough that the downstream assistant should consider fetching it before answering.
- Open Classify does not fetch memory; it only emits query hints.
- Return an empty array when the request is self-contained, asks for general knowledge, depends only on current conversation history, or needs live tools rather than saved memory.

Selection guide:
- Generate queries when phrases like "my usual", "the same client", "our project", "what we decided", "preferred", or "like last time" imply saved user context.
- A named person or project is not enough by itself; generate queries only when the requested action likely needs saved facts about that person or project.
- Target the missing fact, not the current task. Good queries look like "user client update writing style" or "launch checklist prior decisions".
- When the supplied conversation window already contains the needed facts, leave queries empty.
- When both memory and tools may help, generate memory queries only for stable user-specific facts.

Constraints:
- Return JSON only.
- Return at most 3 queries.
- Each query should be 3 to 10 words.
- Do not answer the user.
- Do not include secrets or sensitive content verbatim.
```
