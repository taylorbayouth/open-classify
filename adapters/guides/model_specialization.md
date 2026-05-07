# Model Specialization Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating model-specialization training data. Use it with the shared README preamble; this file contains only the model-specialization-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/model_specialization.jsonl`. Hold back 10–20% as an eval split per the README's generation workflow.

## North Star

This classifier picks the model/prompt specialization — `chat`, `writing`, `reasoning`, `planning`, `coding`, `instruction_following`, or `unclear` — that should handle the downstream answer. These enums are not just task categories. Each value means "route to a downstream model and system prompt specialized for this kind of work" at the separately selected model tier. It combines with `model_tier` (from the routing classifier) to resolve a concrete downstream model via `DownstreamModelConfig`, such as `writing.local_strong` or `coding.frontier_strong`. The output populates the model-selection lookup; a wrong specialization sends the request to a model whose system prompt or fine-tune is mismatched, producing a worse answer at the same price.

In the dynamic context-window control story, this classifier doesn't shrink the prompt; it picks the *right* prompt. Two model lanes might both be available at `local_strong` tier, but the `coding` lane includes a coding-specialized system prompt and the `writing` lane includes a writing-specialized one. Sending a code-edit task to the writing lane wastes the specialized prompting on a mismatched task.

A small dedicated model exists for this so the specialization decision happens locally without a frontier round-trip. The choice is information-light per call (one of seven values) but high-leverage on output quality.

## Quick-Start (Human Curator)

A row is one JSON line. Choose the model specialization best suited to the latest user message — the downstream model/prompt family that should produce the final answer after tier routing is applied.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"chat\",\"reason\":\"The request is a general conversational answer.\"}"}]}
```

## What We Are Fine Tuning For

The classifier picks one model/prompt specialization that should drive downstream model selection. It should learn:

- The enum is a routing key for specialized model behavior, not a generic topic label.
- The lane is about the *final intended output* and the model specialization best suited to produce it, not about tool use or execution mode. Repo work needing tools is still `coding`.
- Tool use does not imply a specialization. `tool_assisted` execution can be any lane.
- When uncertain between `chat` and a more specific lane, prefer the more specific one. `chat` is the default, not the safe pick.
- When uncertain between `reasoning` and a more specific lane (writing, planning, coding, instruction_following), prefer the more specific one. `reasoning` is broad; the others are sharp.
- `instruction_following` is a strict-format-compliance lane, not "the user gave me a constraint." Use it only when precise rule/schema compliance is the *core* task.
- `unclear` is the escape hatch for genuinely unparseable requests, not for the model's hesitation.

## What Failure Costs In Production

Tagged with the README's Cost-Of-Error Vocabulary:

- **Wrong specialization (accuracy impact).** The downstream model gets a mismatched system prompt — a coding task answered by a writing-tuned model produces prose explanations instead of working code; a writing task answered by an instruction-following model produces stiff schema-shaped output instead of natural prose. Same model tier, same cost, worse answer.
- **Defaulting to `chat` (accuracy impact).** `chat` is the most generic lane. Picking it when the task is actually `writing`, `coding`, `planning`, `reasoning`, or `instruction_following` means the downstream model gets the generic prompt and produces generic output. Common failure mode for short messages that *look* conversational but request specific work.
- **Defaulting to `reasoning` (accuracy impact).** `reasoning` is the second most generic lane. Tradeoff discussions and recommendations belong here, but extraction tasks, planning tasks, and writing tasks should drop to their specific lane. Picking `reasoning` when `instruction_following` was right means the model treats a strict-extraction task as an open analysis.
- **Over-using `instruction_following` (accuracy impact).** This is a narrow lane for "the structure of the output IS the task" — JSON extraction, format conversion, rule-bound classification. Picking it because the user said "be concise" or "use bullet points" sends ordinary writing tasks to the wrong lane.
- **Over-using `unclear` (cost + accuracy impact).** When `unclear` is emitted, the caller must fall back to a default lane or escalate to a frontier model with full context. Use `unclear` only when the message is genuinely too malformed or context-missing to identify a lane — not when the model is hesitant between two plausible lanes.

**Bias the training data accordingly.** When a careful reader can identify the intended output type, pick the matching specific lane. Reserve `chat` for genuinely conversational requests where no other lane fits. Reserve `unclear` for genuinely opaque messages.

## Output Contract

```json
{"model_specialization":"chat|writing|reasoning|planning|coding|instruction_following|unclear","reason":"<one sentence>"}
```

- `model_specialization` (required): exactly one of the seven enum values, lowercase, snake_case.
- `reason` (required): compact diagnostic explanation for the model specialization choice, under 200 characters.

JSON key order: `model_specialization`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Enum Meanings

Read every enum as "send this request to the downstream model/prompt specialized for...":

- `chat`: general conversation, normal answers, explanations, discussion, casual Q&A.
- `writing`: drafting, rewriting, summarizing, translating, polishing, tone/style matching, prose formatting.
- `reasoning`: analysis, comparison, diagnosis, evaluation, recommendations, tradeoffs, critique, decision support.
- `planning`: plans, roadmaps, checklists, specs, strategies, sequencing, task decomposition, operational next steps.
- `coding`: code questions, debugging, repo inspection, tests, implementation, refactors, code review, code edits.
- `instruction_following`: strict extraction, classification, conversion, schema filling, rule application, exact format compliance.
- `unclear`: too malformed or context-missing to identify which model specialization should handle it.

## Common LLM Failure Modes When Generating Specialization Data

Watch for these:

1. **Defaulting `chat` for short messages.** A short message is not a chat request. "Tighten this paragraph" is `writing`. "What's the bug here" with code attached is `coding`. Length is not the discriminator; the requested output type is.
2. **Picking `reasoning` for everything analytical.** Comparison + recommendation is `reasoning`. But "compare these three subject lines and pick the best one" with the actual writing implied is closer to `writing` if the deliverable is the chosen line; closer to `reasoning` if the deliverable is the comparison itself. Pick by the deliverable.
3. **Picking `instruction_following` for any constraint.** "Write a 60-word LinkedIn post" is `writing` with a length constraint, not `instruction_following`. "Extract the invoice number, vendor, and total as a JSON object" is `instruction_following` because the structure IS the task.
4. **Picking `coding` for anything containing code.** "Explain what this regex does" is `chat` (general explanation). "Fix the bug in this regex" is `coding` (the deliverable is changed code).
5. **Picking `planning` for any list.** "Make a checklist" is `planning`. "Give me three pros and three cons" is `reasoning`. The discriminator is whether the list is *actionable next steps* or an *analytical breakdown*.
6. **Output-shape drift.** Lock the JSON shape; vary only the user message.

## The Discriminator

A two-step test decides every row:

> Step 1: What is the deliverable — the actual final output the downstream model should produce?
> Step 2: Which specialized downstream model/prompt should produce that deliverable?

- Prose for human consumption → `writing`.
- Code, code edits, debugging output, code review → `coding`.
- Actionable next steps, sequencing, decomposition → `planning`.
- Comparison, tradeoff analysis, evaluation, recommendation → `reasoning`.
- Strict-format extraction, classification, conversion, schema filling → `instruction_following`.
- Conversational answer, general explanation, open-ended discussion → `chat`.
- Genuinely too unclear to identify → `unclear`.

When two specific lanes both fit, pick the one matching the highest-skill part of the deliverable. When `chat` and a specific lane both fit, pick the specific lane. When `reasoning` and a more specific non-reasoning lane both fit, pick the more specific one.

## Lane Boundaries

These pairs are the most-confused boundaries. Each generated batch should include 4–6 boundary pairs covering them:

- **`chat` vs `writing`.** "What's a good way to phrase a polite refusal" → `chat` (general advice). "Write a polite refusal to this meeting invite" → `writing` (deliverable is the message).
- **`chat` vs `reasoning`.** "What is event sourcing" → `chat` (general explanation). "Should we use event sourcing for this app — what are the tradeoffs and what do you recommend" → `reasoning` (deliverable is a recommendation with analysis).
- **`reasoning` vs `planning`.** "Evaluate whether to migrate to Postgres" → `reasoning` (deliverable is the evaluation). "Plan the Postgres migration" → `planning` (deliverable is the actionable sequence).
- **`reasoning` vs `writing`.** "Compare these three subject-line options" → `reasoning` if the deliverable is the comparison; `writing` if the deliverable is the chosen line ready to send.
- **`coding` vs `chat`.** "Explain what this Python loop does" → `chat` (general explanation). "Refactor this Python loop to use a generator" → `coding` (deliverable is the refactored code).
- **`coding` vs `instruction_following`.** "Fix the failing test in this repo" → `coding` (deliverable is changed code). "Convert this JSON object to YAML, preserving the key order exactly" → `instruction_following` (deliverable's structure IS the task).
- **`writing` vs `instruction_following`.** "Write a 60-word LinkedIn post about our seed round" → `writing` (length is a constraint on prose). "Reformat this product page text into the exact schema below: {title, subtitle, bullets[]}" → `instruction_following` (the schema IS the task).
- **`planning` vs `instruction_following`.** "Make a five-task migration checklist" → `planning` (deliverable is actionable steps in any reasonable format). "Extract the next steps from this meeting transcript and return as JSON: [{owner, action, due_date}]" → `instruction_following` (the schema IS the task).

## Diversity Dimensions And Seed Lists

Sample combinations from these axes — do not free-generate.

**Surface:** slack DM, email, web chat, voice transcript, terminal/CLI, support form, code review comment, mobile push reply.

**Length:** one phrase, one sentence, paragraph, multi-paragraph elaborate request.

**Register:** corporate, peer-casual, terse expert, frustrated, multilingual fragments, ALL CAPS, lowercase no-punctuation.

**Domain:** software engineering, data analysis, product strategy, marketing, finance/accounting, legal, medical/health (general), customer support, education, creative writing, household logistics, travel planning, recruiting/HR.

**Deliverable type cues:** "explain", "what is" → `chat`; "draft", "write", "rewrite", "polish", "translate", "summarize" → `writing`; "compare", "evaluate", "should we", "tradeoffs" → `reasoning`; "plan", "checklist", "roadmap", "next steps" → `planning`; "fix", "refactor", "implement", "debug", "review the code" → `coding`; "extract", "convert", "classify as", "reformat into", "return as JSON" → `instruction_following`.

**User personas:** senior engineer, junior dev, founder, designer, PM, marketer, recruiter, parent, student, scientist, sales rep, support agent, lawyer, doctor, writer.

**Multi-message windows:** **5–10% of rows.** Lane decisions are usually evident from the latest message alone. Reserve multi-message rows for cases where the lane shifts mid-conversation (e.g., earlier turn was `coding` debugging, latest turn is "now write the announcement for the fix" → `writing`).

## Boundary Pairs (Generate These Adjacent In Output)

Generate **6–10 pairs per batch**, emitted on adjacent lines. Cover the most-confused boundaries listed above. Each pair: same surface, one tiny diff, flipped lane.

Example pair shapes (do not copy the inputs verbatim):

- **chat vs writing.** "What's a good closing line for an apology email" → `chat`. "Write the closing line for this apology email" → `writing`.
- **chat vs coding.** "Explain how websockets handshake works" → `chat`. "Implement a websocket handshake handler in this codebase" → `coding`.
- **reasoning vs planning.** "Should we migrate from Mongo to Postgres" → `reasoning`. "Plan the Mongo to Postgres migration" → `planning`.
- **writing vs instruction_following.** "Write a punchy product description for this lamp" → `writing`. "Extract the product name, dimensions, and price from this listing as JSON" → `instruction_following`.
- **coding vs instruction_following.** "Refactor this function to be more readable" → `coding`. "Convert this function from JavaScript to TypeScript with strict mode types" → `coding` (still code work — TypeScript output is code, not a schema). "Convert this JSON to the exact YAML structure shown below" → `instruction_following`.
- **planning vs instruction_following.** "Build a launch checklist for next week" → `planning`. "Reformat this freeform launch list into [{step, owner, due}] JSON" → `instruction_following`.
- **reasoning vs writing on a sensitive topic.** "Compare three approaches for telling the team about layoffs and recommend one" → `reasoning`. "Write the layoff message I'll send tomorrow" → `writing`.

## Gotchas

- "Help me think through X" is `reasoning`, not `chat`.
- "Write code that does X" is `coding`, not `instruction_following`, even if the output has structure.
- "Return as JSON" is the strongest `instruction_following` signal.
- "Plan", "roadmap", "checklist", "next steps", "sequence" all point to `planning`.
- A constraint on a writing task ("60 words", "in their voice") doesn't promote it to `instruction_following`. The constraint is on style, not on a strict schema.
- Tool use ≠ specialization. `tool_assisted + coding` is common; so is `tool_assisted + writing` ("find the email and draft a reply").
- A request to *evaluate code* without changing it is `coding` (review is a coding-specialized skill), not `reasoning`.
- A casual "hey what do you think about X" with no specific deliverable is `chat`.
- `unclear` is rare. Most messages have an identifiable deliverable type even if other dimensions are ambiguous.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Label distribution (per 100):**
  - 15–20 `chat`
  - 15–20 `writing`
  - 20–25 `reasoning`
  - 10–15 `planning`
  - 15–20 `coding`
  - 10–15 `instruction_following`
  - 3–5 `unclear`
- **Multi-message windows:** 5–10% of rows. Mostly lane-shift rows (prior turn was one lane, latest turn shifts to another).
- **Boundary pairs:** 6–10 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE — do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly two keys: `model_specialization` and `reason`.
3. The specialization choice matches the deliverable, not the tool family or execution mode.
4. `reason` is short, factual, and consistent with the chosen lane.
5. The user message is not a near-duplicate of any prior row in this batch and not a string copied from this guide's worked examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot identify the deliverable type after applying the discriminator. Skip rather than emit `unclear` as a hedge.
- You cannot decide between two adjacent lanes even after applying the "prefer the more specific" rule. Skip.
- The message uses real-world identifiers, secrets, names, or contact details. Use realistic but fictional substitutes.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

Chat — general explanatory question:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhy do bridges sometimes oscillate in the wind\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"chat\",\"reason\":\"The request is a general explanatory question with no specific deliverable.\"}"}]}
```

Writing — drafting prose:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ndraft a warm two-sentence note thanking the design team for the rebrand work\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"writing\",\"reason\":\"The deliverable is composed prose for human consumption.\"}"}]}
```

Reasoning — tradeoff analysis with recommendation:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nshould our four-person team adopt kubernetes now or stay on docker compose for another year\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"reasoning\",\"reason\":\"The request asks for tradeoff analysis and a recommendation.\"}"}]}
```

Planning — actionable sequencing:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nbreak the website redesign into a four-week plan with weekly milestones\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"planning\",\"reason\":\"The deliverable is an actionable sequenced plan.\"}"}]}
```

Coding — implementation work:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrefactor the upload handler to use streaming instead of buffering the whole file\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"coding\",\"reason\":\"The deliverable is changed code in the codebase.\"}"}]}
```

Instruction_following — strict schema extraction:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nfrom the meeting transcript below, return a json array of objects with keys owner, action_item, due_date in iso 8601 — no other keys, no commentary\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"instruction_following\",\"reason\":\"The strict output schema is the core task.\"}"}]}
```

Unclear — too opaque to identify a lane:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nso the thing about the other thing again\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"unclear\",\"reason\":\"The latest message is too referential to identify a deliverable type.\"}"}]}
```

Boundary pair — chat vs writing on the same surface (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat's a tactful way to ask my landlord to fix the heater\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"chat\",\"reason\":\"The request is general advice with no specific message to compose.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwrite the email to my landlord asking him to fix the heater this week\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"writing\",\"reason\":\"The deliverable is the composed email.\"}"}]}
```

Boundary pair — coding vs instruction_following (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrewrite this python function to be more idiomatic\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"coding\",\"reason\":\"The deliverable is improved code.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ngiven the following python function signature and docstring, return a json object with keys name, params (array of {name, type}), return_type — no commentary\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"model_specialization\":\"instruction_following\",\"reason\":\"The strict output schema is the core task.\"}"}]}
```

## Appendix — Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the model specialization classifier for an AI assistant handoff system.

Choose the model/prompt specialization best suited to the latest normalized user message.

This is not a generic task taxonomy. Each enum value means "route to a downstream model and system prompt specialized for this kind of work" at the separately selected model tier.

Return ONLY valid JSON matching:
{"model_specialization":"chat|writing|reasoning|planning|coding|instruction_following|unclear","reason":"<one sentence>"}

Values:
- "chat": route to a general conversation model/prompt for answers, explanations, discussion, casual conversation, lightweight Q&A, or a normal assistant response.
- "writing": route to a writing-specialized model/prompt for drafting, rewriting, summarizing, translating, polishing, tone changes, style matching, or prose formatting.
- "reasoning": route to a reasoning-specialized model/prompt for analysis, comparison, diagnosis, evaluation, recommendation, tradeoff discussion, critique, or decision support.
- "planning": route to a planning-specialized model/prompt for plans, roadmaps, checklists, specs, strategies, sequencing, task decomposition, or operational next steps.
- "coding": route to a coding-specialized model/prompt for code questions, debugging, repo inspection, tests, implementation, refactors, code review, or code edits.
- "instruction_following": route to an instruction-following-specialized model/prompt for precise extraction, classification, conversion, schema filling, rule application, or strict format compliance where obeying explicit constraints is the main task.
- "unclear": choose this when the latest message is too malformed or context-missing to identify which model specialization should handle it.

Selection guide:
- Choose the specialization that should combine with the separately selected model tier to resolve a concrete downstream model, such as writing.local_strong or coding.frontier_strong.
- Choose the specialization that should drive model selection and prompt specialization, not the execution mode or tool access.
- Ask: "Which specialized downstream model would produce the best final answer for this request?"
- Do not use "instruction_following" merely because the user included a constraint; use it when precise rule/schema compliance is the core task.
- Tool use does not imply a specialization by itself.
- When a request mixes modes, choose the specialization for the final intended output or highest-skill part.
- If both "chat" and another value seem plausible, prefer the more specific non-chat value when the task is primarily writing, reasoning, planning, coding, or instruction compliance.
- If both "reasoning" and another value seem plausible, prefer the more specific non-reasoning value when the task is primarily writing, planning, coding, or instruction compliance.

Constraints:
- Return JSON only.
- Choose exactly one model_specialization.
- Do not return concrete model names or model tiers.
- Keep "reason" under 200 characters.
```
