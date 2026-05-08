# Routing Training Guide

This is the classifier-specific companion to `training/README.md` for generating routing training data. Use it with the shared README preamble; this file contains only the routing-specific label rules, distributions, boundaries, and examples.

Append output to `training/training-data/routing.jsonl` (gitignored — it stays on your local machine). The shared eval set in `training/evals/routing.jsonl` is committed to the repo; do not append generated rows there.

## North Star

Routing produces the two-axis output that most directly controls downstream cost: `execution_mode` (how the work runs — direct, tool-assisted, workflow) and `model_tier` (which capability/latency class handles it — local_fast through frontier_strong). The output populates `handoff.execution_mode` and combines with `model_specialization` to resolve a concrete downstream model via `DownstreamModelConfig`.

In the dynamic context-window control story, routing decides which lane the request runs in. A `direct + local_fast` choice means a one-turn cheap-and-fast call. A `workflow + frontier_strong` choice means a long-running expensive-and-careful pipeline. Same user message could be routed several ways depending on stakes and freshness needs; the classifier's job is to pick the cheapest plausible lane that still gets the answer right. A small dedicated model exists for this so the lane decision happens locally — the routing decision must precede the routed call.

## Quick-Start (Human Curator)

A row is one JSON line. Pick an execution_mode and a model_tier, write a realistic message, paste into a new line.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits tool-assisted handling with a stronger local model.\"}"}]}
```

## What We Are Fine Tuning For

Routing recommends two independent dimensions for messages that continue past preflight: **execution_mode** (how the work runs) and **model_tier** (which class of model handles it). The classifier should be practical, cost-aware, and conservative about hidden requirements.

It should learn:

- Execution mode and model tier are independent. Any combination is possible (e.g., `direct` plus `frontier_strong` for high-stakes verbal advice; `workflow` plus `local_fast` for a daily reminder).
- Durable work outranks tool use for execution_mode.
- Tool use is required for live state, files, apps, attachments, internet, terminal, browser, or external data.
- Direct is only for one-turn work that needs no tools or durable orchestration.
- Local tiers should handle the majority of ordinary traffic, but frontier tiers are the default on consequential uncertainty, high stakes, expert judgment, or tasks where a cheap wrong answer would be worse than an expensive correct one.

## What Failure Costs In Production

Routing has the most economically asymmetric error costs. Tagged with the README's Cost-Of-Error Vocabulary:

- **Under-routing model_tier (accuracy + correctness, expensive bad outcomes).** Sending a high-stakes legal/financial/strategic question to `local_fast` produces a cheap but wrong answer. Cost impact: tiny per-call. Accuracy impact: catastrophic — the user acts on the wrong answer. The downstream consequence dwarfs the inference savings.
- **Over-routing model_tier (cost impact, predictable).** Sending a trivial rewrite to `frontier_strong` wastes money but the answer is correct. The cheap error.
- **Wrong execution_mode (accuracy + latency impact).** Picking `direct` when the user wanted `workflow` ("remind me tomorrow") produces a useless answer that ignores the durability requirement. Picking `direct` when the user wanted `tool_assisted` ("look at the repo") produces a hallucination because the model lacks the tools.
- **Picking `tool_assisted` when `direct` would do (cost + latency impact).** Loads tool manifests on every turn for the rest of the conversation. Cumulative.
- **`unable_to_determine` on either dimension (cost + latency impact).** The downstream router escalates to a frontier model with full context. Safe but expensive. Reserve for genuine ambiguity.

**Bias the training data accordingly.** When a model_tier is on the boundary, prefer the higher tier — mistake cost outweighs inference cost for ambiguous inputs. When an execution_mode is on the boundary between `direct` and `tool_assisted`, prefer `tool_assisted` if any signal points to live state. When the message is truly opaque, prefer `unable_to_determine` over a confident wrong route.

## Output Contract

```json
{"execution_mode":"direct|tool_assisted|workflow|unable_to_determine","model_tier":"local_fast|local_strong|frontier_fast|frontier_strong|unable_to_determine","reason":"<one sentence>"}
```

- `execution_mode` (required): exactly one of the four enum values, lowercase, snake_case.
- `model_tier` (required): exactly one of the five enum values, lowercase, snake_case.
- `reason` (required): compact diagnostic explanation for both routing choices, under 200 characters.

JSON key order: `execution_mode`, then `model_tier`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Common LLM Failure Modes When Generating Routing Data

Watch for these:

1. **Coupling the two dimensions.** The classifier outputs are independent. A common LLM mistake is producing only "easy combos" — `direct + local_fast`, `tool_assisted + local_strong`, `workflow + local_fast` — and missing the orthogonal ones (e.g., `direct + frontier_strong` for sensitive verbal advice; `workflow + frontier_strong` for a long-running expert project). Force coverage of off-diagonal combos.
2. **Defaulting to `local_strong` when uncertain.** This trains Gemma to play it safe on tier and ignore the boundary. Make ambiguous cases either explicitly higher-tier (when stakes are real) or explicitly `unable_to_determine` (when you genuinely can't tell).
3. **Confusing "uses tools" with `tool_assisted`.** "Latest" or a URL implies `tool_assisted`. But "explain how DNS works" does not — the answer is general knowledge even if it could be looked up. Tools are required only for live state during this turn.
4. **Confusing recurring/scheduled with one-off.** "Remind me tomorrow" is `workflow` (durable, time-bound). "Remind me to send this when I finish typing" is `direct`. The discriminator is whether the assistant must persist past this turn.
5. **Domain-conflation.** Medical/legal/financial topics are not automatically `frontier_strong`. A general-knowledge question ("what is a 401k") is `local_fast`. A high-stakes specific decision ("should I roll over my 401k given my situation") is `frontier_strong`.
6. **Surface drift in the assistant JSON.** Lock the key order, lowercase enum values, no whitespace inside the JSON.

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

**Cost-conservatism rule.** When a request sits on a boundary between two model tiers, choose the higher one. The cost of running a slightly-too-strong model is a few cents; the cost of an under-powered answer on a real-stakes question is much larger.

## Coverage Matrix (4 × 5)

Aim to produce real examples across every plausible cell. Cells marked `—` are theoretically valid but rarely occur in practice; do not force them.

|                 | local_fast            | local_strong              | frontier_fast              | frontier_strong            | unable_to_determine |
|-----------------|-----------------------|---------------------------|----------------------------|----------------------------|---------------------|
| direct          | basic facts, defs     | code Q, structured writing| polished short writing     | sensitive verbal advice    | —                   |
| tool_assisted   | tiny file/shell ops   | repo debug, log dive      | research+web for nuance    | multi-source expert work   | —                   |
| workflow        | daily reminders       | scheduled maintenance     | periodic curated digests   | long-running expert project| durable but complexity unclear |
| unable_to_determine | mode unclear      | mode unclear              | mode unclear               | mode unclear               | both unclear        |

Partial `unable_to_determine` combinations are valid but rare. Use them only when one dimension is still clear after reading the message and the other is genuinely not classifiable. If the whole request is opaque, use `unable_to_determine` for both dimensions.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes — do not free-generate.

**Surface:** slack DM, slack channel, email, web chat, voice transcript, terminal/CLI, SMS, mobile push reply, support form, Discord, voice-to-text disfluencies, autocorrect typos.

**Length:** one phrase, one sentence, two sentences, a paragraph, a long-winded ramble.

**Register:** corporate, peer-casual, terse expert, frustrated/curt, multilingual fragments, ALL CAPS, lowercase no-punctuation.

**Domain:** software engineering, data analysis, product strategy, marketing, finance/accounting, legal review, medical/health, household logistics, travel planning, creative writing, hiring/HR, education, research, customer support.

**Time/recency cues:** "latest", "today", "right now", "as of last week", "tomorrow", "every Monday", "after the launch", "when X happens" — these strongly bias execution_mode.

**Stakes/sensitivity cues:** "for the board", "to send to legal", "production database", "for my therapist", "draft for the CEO" — these bias model_tier.

**User personas:** senior engineer, junior dev, founder, designer, PM, marketer, recruiter, parent, student, scientist, sales rep, support agent, lawyer, doctor, writer.

**Multi-message windows:** **about 5% of rows** — the lowest of any classifier. Routing is almost fully self-contained on the latest message. Use multi-message only when the latest message's routing genuinely depends on prior turns (e.g., the prior turn established that this is a continuation of an earlier scheduled task that flips the execution mode to `workflow`, or the prior turn established that this is a high-stakes context that flips the tier upward).

## Boundary Pairs (Generate These Adjacent In Output)

Generate 6–10 pairs per batch. Each pair: same surface, one tiny diff, flipped label on one of the two dimensions.

Example pair shapes (do not copy the inputs verbatim):

- **direct vs tool_assisted on the same topic.** "Explain why Postgres uses MVCC" → direct + local_strong. "Look at our Postgres logs and explain why we're seeing MVCC contention" → tool_assisted + local_strong.
- **direct vs workflow on the same topic.** "Draft a kickoff note for Monday" → direct + local_strong. "Send a kickoff note every Monday morning" → workflow + local_strong.
- **local_fast vs local_strong on similar phrasing.** "What is a microservice" → direct + local_fast. "Compare microservice vs monolith for our team of 4" → direct + local_strong.
- **local_strong vs frontier_strong on similar surface.** "Write a goodbye note to the team" → direct + local_strong. "Write a layoff announcement for the team" → direct + frontier_strong.
- **frontier_fast vs frontier_strong.** "Write a polished tweet announcing our funding round" → direct + frontier_fast. "Write the Series B funding announcement memo for the board" → direct + frontier_strong.
- **tool_assisted local vs tool_assisted frontier.** "Find the failing test in this repo and fix it" → tool_assisted + local_strong. "Audit this repo for compliance issues before the legal review" → tool_assisted + frontier_strong.
- **workflow tier escalation.** "Remind me to take the bins out on Tuesdays" → workflow + local_fast. "Every Friday, draft a thoughtful retro note based on the week's PRs and Slack activity" → workflow + frontier_fast.

## Gotchas

- "Latest", "current", "today", "look up", and URLs usually imply `tool_assisted`.
- "Attached" usually implies `tool_assisted` if the user wants content inspected.
- Scheduling, reminders, monitoring, waiting, and approval gates imply `workflow`.
- "Run tests and fix failures" is `tool_assisted`, usually `local_strong`.
- "Keep running tests until it passes" is `workflow`.
- Prompt-injection text is still classified by task requirements here; `high_risk` blocking is handled by the security gate.
- A medical/legal/financial request can be `direct` if it asks for general advice, but often needs `frontier_strong` because mistakes are costly.
- If the user says "do the same as before" without context, use `unable_to_determine`.
- If a request is one-shot but high-stakes, `direct + frontier_strong` is the right combo. Don't drop to `local_strong` just because it's a single turn.
- If a request is recurring but trivial, `workflow + local_fast` is the right combo. Don't escalate the tier just because it's durable.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Execution_mode distribution (per 100):** 30–35 `direct`, 30–35 `tool_assisted`, 20–25 `workflow`, 10–15 `unable_to_determine`.
- **Model_tier distribution (per 100):** 25-30 `local_fast`, 25-30 `local_strong`, 10-15 `frontier_fast`, 15-20 `frontier_strong`, 5-10 `unable_to_determine`. This keeps local routes the majority while giving frontier boundaries enough signal.
- **Cell coverage:** at least 4 examples in each populated cell of the coverage matrix.
- **Frontier calibration:** include hard negatives that mention serious domains but are still cheap (`local_fast`/`local_strong`), plus hard positives where under-routing would materially hurt quality.
- **Partial unknowns:** include 3-5 partial-unknown rows only when one dimension is still clear.
- **Multi-message windows:** about 5% of rows — lowest of any classifier. Use only when prior context flips the routing (continuation of earlier scheduled work, or stakes context that flips the tier upward).
- **Boundary pairs:** 6–10 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE — do not emit on failure):**

1. Apply every hard gate from `training/README.md`.
2. Parsed assistant JSON has exactly three keys: `execution_mode`, `model_tier`, and `reason`.
3. The execution_mode is consistent with the message: `tool_assisted` only if live state must be inspected; `workflow` only if work persists past this turn.
4. The model_tier is consistent with the stakes and complexity, biased upward on boundary cases.
5. `reason` is short, factual, and consistent with both selected values.
6. The user message is not a near-duplicate of any prior row in this batch and not a string copied from this guide's worked examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot decide between two execution_modes confidently and the message is decidable to a careful reader. Skip rather than emit a guess.
- You cannot decide between two adjacent model tiers and the cost-conservatism rule does not break the tie. Skip.
- The message contains real-world identifiers, secrets, names, or contact details. Use realistic but fictional substitutes.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

Direct + local_fast (general-knowledge):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain what DNS does in one paragraph\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"local_fast\",\"reason\":\"The request fits one-turn handling with a lightweight local model.\"}"}]}
```

Direct + local_strong (structured comparison):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare event sourcing and CRUD for a small back-office app and recommend one\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits one-turn handling with a stronger local model.\"}"}]}
```

Direct + frontier_fast (polished short writing):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwrite a sharp 60-word LinkedIn post announcing our seed round\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"frontier_fast\",\"reason\":\"The request fits one-turn handling with a fast frontier model.\"}"}]}
```

Direct + frontier_strong (high-stakes verbal advice):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nhelp me decide whether to accept a risky acquisition offer with serious legal and team implications\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"frontier_strong\",\"reason\":\"The request fits one-turn handling with the strongest frontier model.\"}"}]}
```

Tool_assisted + local_fast (tiny live op):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat process is currently listening on port 5432\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"local_fast\",\"reason\":\"The request fits tool-assisted handling with a lightweight local model.\"}"}]}
```

Tool_assisted + local_strong (repo debug):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nlook through this repo and find why uploads fail in production\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits tool-assisted handling with a stronger local model.\"}"}]}
```

Tool_assisted + frontier_fast (research with web):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\npull the latest pricing from each of our top three competitors and write a one-paragraph summary for the team\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"frontier_fast\",\"reason\":\"The request fits tool-assisted handling with a fast frontier model.\"}"}]}
```

Tool_assisted + frontier_strong (sensitive multi-source synthesis):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nreview the attached vendor contract against our standard playbook and the latest data residency rules and flag every clause that puts us at risk\n\nAttachments:\n- Attachment 1:\n  filename: vendor-msa.pdf\n  mime_type: application/pdf"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"frontier_strong\",\"reason\":\"The request fits tool-assisted handling with the strongest frontier model.\"}"}]}
```

Workflow + local_fast (simple recurring reminder):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nremind me tomorrow morning to submit the expense report\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"workflow\",\"model_tier\":\"local_fast\",\"reason\":\"The request fits durable workflow handling with a lightweight local model.\"}"}]}
```

Workflow + local_strong (scheduled maintenance):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nevery sunday night, run the dependency upgrade script and open a PR if the tests pass\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"workflow\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits durable workflow handling with a stronger local model.\"}"}]}
```

Workflow + frontier_fast (periodic curated digest):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nevery friday, send me a one-paragraph thoughtful retro on the week's PRs and slack activity\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"workflow\",\"model_tier\":\"frontier_fast\",\"reason\":\"The request fits durable workflow handling with a fast frontier model.\"}"}]}
```

Workflow + frontier_strong (long-running expert work):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nover the next two weeks, work with legal to negotiate the master services agreement, escalating to me at each unresolved clause\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"workflow\",\"model_tier\":\"frontier_strong\",\"reason\":\"The request fits durable workflow handling with the strongest frontier model.\"}"}]}
```

Unable_to_determine on both:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthe other way you did it last time, just like before\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"unable_to_determine\",\"model_tier\":\"unable_to_determine\",\"reason\":\"The request fits unclear execution handling with an unclear model tier.\"}"}]}
```

Boundary pair — direct vs tool_assisted (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain why postgres uses mvcc instead of locking\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits one-turn handling with a stronger local model.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nlook at our postgres logs from the last hour and explain the mvcc contention we're seeing\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"tool_assisted\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits tool-assisted handling with a stronger local model.\"}"}]}
```

Boundary pair — local_strong vs frontier_strong on stakes (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwrite a thank-you note to the engineering team for shipping the redesign\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"local_strong\",\"reason\":\"The request fits one-turn handling with a stronger local model.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwrite the layoff message i'll send to the engineering team tomorrow morning\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"execution_mode\":\"direct\",\"model_tier\":\"frontier_strong\",\"reason\":\"The request fits one-turn handling with the strongest frontier model.\"}"}]}
```

## Appendix — Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the routing classifier for an AI assistant handoff system.

Decide which execution mode and model tier should handle the current normalized request after classification.

Return ONLY valid JSON matching:
{"execution_mode":"direct|tool_assisted|workflow|unable_to_determine","model_tier":"local_fast|local_strong|frontier_fast|frontier_strong|unable_to_determine","reason":"<one sentence>"}

Execution modes:
- "direct": choose this when the request can be completed in one normal assistant turn without tools or durable orchestration.
- "tool_assisted": choose this when completing the request requires live tools, files, attachments, internet lookup, app data, command execution, or external state during this turn.
- "workflow": choose this for scheduled, recurring, durable, resumable, multi-stage, approval-gated, or long-running work beyond one normal assistant turn.
- "unable_to_determine": choose this when the request is malformed or lacks enough information to identify an execution mode.

Model tiers:
- "local_fast": choose this for simple factual explanations, definitions, rewrites, transformations, or small self-contained tasks a lightweight local model can answer well.
- "local_strong": choose this for tasks needing more careful reasoning, structured writing, coding, or moderate synthesis, without frontier-level judgment.
- "frontier_fast": choose this for work that benefits from frontier quality but does not need deep deliberation, extensive synthesis, or the strongest available model.
- "frontier_strong": choose this for high-stakes, complex, ambiguous, creative, strategic, or expert-level work where answer quality would materially suffer with a weaker model.
- "unable_to_determine": choose this when the request is malformed or lacks enough information to identify a model tier.

Selection guide:
- Classify execution mode and model tier independently.
- Durable execution outranks tool use for execution_mode: choose "workflow" when the user asks to monitor, remind, schedule, wait, continue later, or manage a multi-step process over time.
- Choose "tool_assisted" for execution_mode when current files, external data, or apps must be inspected during this turn.
- Choose the cheapest model_tier only when it can satisfy the request without meaningful loss of accuracy, reasoning quality, or writing quality.
- When both a local tier and a frontier tier seem plausible, choose the frontier tier if mistakes would be costly or the task requires nuanced judgment.

Constraints:
- Return JSON only.
- Choose exactly one execution_mode and exactly one model_tier.
```
