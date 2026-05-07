# Preflight Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating preflight training data. Use it with the shared README preamble; this file contains only the preflight-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/preflight.jsonl`. Hold back 10–20% as an eval split per the README's generation workflow.

## North Star

Preflight is the first early-exit gate in the pipeline and the most direct cost lever in Open Classify. When `terminality: "terminal"` comes back from the model (not the fallback), the pipeline aborts every other classifier and the assistant's `reply` is delivered verbatim as the final answer — no downstream model call, no tool use, no escalation. Greetings, thanks, tiny self-contained questions, and acknowledgement closers never reach the frontier.

In the dynamic context-window control story, this is the cleanest win: a correct `terminal` saves an entire frontier call. A correct `continue` is the price of admission for everything else — it keeps the pipeline running so the other six classifiers can build the lean handoff. A wrong `terminal` discards the user's actual request and replaces it with a polite phrase. A small dedicated model exists for this so the gating decision happens in milliseconds locally; if you waited for the frontier model to "decide it doesn't need to do work," you'd already have paid for the work.

## Quick-Start (Human Curator)

A row is one JSON line. The user message wraps the conversation window; the assistant message is the classifier's JSON output, and nothing else. Pick a label, write a realistic message, write a 1–5 word reply, add a short reason, paste into a new line.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"Let me check.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

## What We Are Fine Tuning For

Preflight is the master gate of the pipeline. It runs in parallel with the other six classifiers, but if it returns `terminality: "terminal"`, the pipeline aborts every other classifier and the assistant's `reply` is delivered verbatim as the final answer. There is no downstream work, no tool use, no escalation.

Preflight stops the pipeline only when a 1–5 word `reply` written from the message alone is the complete assistant response. Otherwise it routes onward.

The behavior is conservative:

- Be quick and human.
- Keep `reply` short, usually 1 to 5 words.
- Use `terminal` only when the `reply` is the complete answer.
- Use `continue` when there is any substantive task, hidden context, or external need.
- Use `unable_to_determine` only for messages too unclear to classify confidently.

## What Failure Costs In Production

Preflight has the most asymmetric error costs in the system. Tagged with the README's Cost-Of-Error Vocabulary:

- **False terminal (catastrophic, all three axes plus correctness failure).** The user asked for substantive work; we returned `"Hi."` or `"56."` and discarded the request. Cost impact: zero on the surface, but the user re-asks immediately, so the system pays twice. Accuracy impact: the user gets a wrong answer that pretends to be the answer. Latency impact: doubled round-trip count once the user notices. The entire downstream pipeline never ran.
- **False continue (cheap, mostly cost + latency).** The message could have been answered with a phrase, but we routed it to the rest of the pipeline. Cost impact: one wasted classifier pass plus a downstream model call. Latency impact: a few hundred milliseconds. Accuracy impact: zero — the user still gets a correct answer.
- **Over-using `unable_to_determine` (cost + latency impact).** The downstream router escalates to a frontier model with full context. Expensive but safe; the user still gets a correct answer.

**Bias the training data accordingly.** When a careful reader is on the boundary between `terminal` and `continue`, the right label is `continue` — the cost gradient is steep. When a careful reader cannot decide what the user even means, the right label is `unable_to_determine`. Reserve `terminal` for cases where the 1–5 word `reply` is unambiguously the complete answer.

## Output Contract

```json
{"terminality":"terminal|continue|unable_to_determine","reply":"<short user-facing line>","reason":"<one sentence>"}
```

- `terminality` (required): exactly one of the three enum values, lowercase, snake_case.
- `reply` (required): non-empty string, usually 1–5 words. For `terminal`, it is the actual answer. For `continue` and `unable_to_determine`, it is a brief acknowledgement that does not answer.
- `reason` (required): compact diagnostic explanation for the terminality choice, under 200 characters.

JSON key order: `terminality`, then `reply`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Common LLM Failure Modes When Generating Preflight Data

Watch for these — they are the most frequent ways generated batches go wrong:

1. **Defaulting `terminal` replies to "How can I help?"** That phrase is a clarification, not an answer. It is wrong on every label. A `terminal` reply must answer the message; an acknowledgement reply on `continue` should not offer help, it should signal in-progress work.
2. **Treating any short message as `terminal`.** "Make it shorter" is short, but it references prior work and is `continue`. Length is not the discriminator; "can a 1–5 word reply be the complete answer" is.
3. **Treating courtesy as terminal.** "Thanks, can you also do X" is `continue`; the request controls.
4. **Cribbing the worked-example phrasings.** Do not reuse the strings shown later in this guide ("hi", "what is 9 minus 4", "that one but cleaner", etc.) as your training inputs. Treat them as illustrative shapes; generate fresh surface forms.
5. **Output-shape drift.** Letting the assistant JSON vary in key order, whitespace, or capitalization. Lock the shape; vary only the user message.
6. **Overusing `unable_to_determine`.** It exists for genuine ambiguity, not for "this is slightly hard." If a careful reader can decide between `terminal` and `continue`, the label is one of those two.

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

The field was renamed from `awk` to `reply` to avoid biasing the model toward acknowledgement-shaped output on terminal cases. Training data must reinforce that `reply` on a `terminal` row is the answer itself, not an offer to help.

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
- **Anything with attached content the user wants used.** Even a one-word "summarize" with an attachment is `continue`.

### Unable_to_determine — placeholder mode

- **Ambiguous fragment with no resolvable referent.** "That one", "do it like before", "no not that".
- **Garbled or contradictory input.** Fragments that cannot be parsed, or that contain contradictions a careful reader cannot reconcile.

## Diversity Dimensions And Seed Lists

When generating a batch, sample combinations from these axes rather than free-generating. Free generation collapses to median quickly.

**Surface (where the message came from):** slack DM, slack channel, email body, web chat, voice transcript, terminal/CLI prompt, SMS, mobile push reply, support form submission, Discord, mobile keyboard with autocorrect, voice-to-text with disfluencies.

**Length:** 1 word, 2–4 words, one short sentence, two sentences, a long paragraph, a multi-paragraph rant, a mid-thought fragment.

**Register:** formal corporate, casual peer, terse expert, friendly customer, frustrated/curt, multilingual code-switching, ALL CAPS, no punctuation lowercase, dictation-style with run-on phrasing, typo-heavy.

**Domain:** software engineering, data analysis, product strategy, marketing copy, finance/accounting, legal review, medical/health (general), education, creative writing, household/personal logistics, travel planning, customer support, scientific research.

**User personas:** senior engineer, junior dev, founder, designer, PM, marketer, recruiter, parent, student, scientist, sales rep, support agent, writer, lawyer.

**Multi-message windows:** target ~10% of preflight rows. Use multi-message only when needed to disambiguate (e.g., the prior message is the work the user is now closing or amending). Most preflight inputs are single-message.

Generate combinations across these axes. Avoid clustering rows on the same persona or domain.

## Boundary Pairs (Generate These Adjacent In Output)

Boundary pairs are the highest-leverage signal for a small model. Each pair is two records with a near-identical user message but flipped labels. Emit them on adjacent lines so the data shows the flip explicitly. Generate 6–10 such pairs per batch.

Example pair shapes (do not copy these inputs verbatim — generate new ones following these shapes):

- **Bare thanks (terminal) vs thanks + request (continue).** "thanks for that" → terminal. "thanks for that — also can you re-check the totals" → continue.
- **Greeting alone (terminal) vs greeting + question (depends).** "hey" → terminal. "hey, what is 7 squared" → terminal. "hey, can you look up flight options" → continue.
- **Tiny factual Q (terminal) vs slightly longer factual Q (continue).** "what's the capital of Belgium" → terminal. "what's the current capital city debate in Belgium about" → continue (needs lookup/synthesis).
- **Acknowledgement closer (terminal) vs implicit task ack (continue).** "okay sounds good" → terminal. "okay sounds good, ship it" → continue.
- **Direct transformation (terminal) vs needs-context transformation (continue).** "spell 'accommodate'" → terminal. "spell-check this paragraph" → continue (needs the paragraph).
- **Single-word fragment (unable_to_determine) vs single-word answer (terminal).** "that" → unable_to_determine. "yes" in response to a yes/no in the prior message (multi-message window) → terminal.

## Gotchas

- Bare greetings ("hi", "hey", "yo") are `terminal`, not `continue`. The model often wants to default to "How can I help?" — train against this.
- "Thanks, ship it" is `continue` (courtesy + request), not `terminal`.
- "Oh make that 4 PM!" is `continue`; it implies a prior task.
- "What is 2+2?" is `terminal` because the answer fits in `reply`.
- "What's the weather?" is `continue`; it needs a lookup.
- "What should I do about this error?" is `continue`; it needs judgment.
- Any message accompanied by an attachment the user wants used is `continue`. The attachment alone routes onward even if the message is "summarize this".
- Do not let `reply` answer substantive requests on `continue` — that is what downstream is for.
- Do not ask clarification questions in `reply`. "How can I help?" is wrong on every label.
- Do not mention routing, classifiers, tools, or models in `reply`.

## Good `reply` Patterns

- `terminal` (answer mode): "Hello.", "Anytime.", "Got it.", "56.", "Paris.", "Tuesday.", "Welcome.", "You're set.", "Sleep well.", "Glad it helped."
- `continue` (placeholder mode): "I'll check.", "I'll update it.", "Let me check.", "On it.", "Looking now.", "I'll handle it."
- `unable_to_determine` (placeholder mode): "Let me check.", "I need context."

Vary phrasing across rows. Do not let any single placeholder string dominate the batch.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200. Stop at the cap; redundancy past that is just cost.
- **Label distribution (per 100):** 40 `continue`, 40 `terminal`, 20 `unable_to_determine`.
- **Sub-distribution within `terminal`:** roughly even across the four sub-shapes (phatic, tiny Q, trivial transformation, acknowledgement closer).
- **Sub-distribution within `continue`:** roughly even across the seven sub-shapes (implicit task, composition, context-needing, lookup-needing, memory-needing, courtesy+request, attachment-driven).
- **Multi-message windows:** about 10% of rows. Use them only when context disambiguates the latest message.
- **Boundary pairs:** 6–10 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE — do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly three keys: `terminality`, `reply`, and `reason`.
3. The label and the reply are consistent: `terminal` replies answer the message in 1–5 words; `continue` and `unable_to_determine` replies are placeholders that do not answer.
4. `reason` is short, factual, and consistent with the label.
5. The user message is not a near-duplicate of any prior row in this batch and not a string copied from this guide's worked examples or appendix.

If any check fails, regenerate the record or skip it. Do not emit a guess.

## Stop Conditions

Refuse to emit a record when:

- You cannot decide between two labels with confidence — emit `unable_to_determine` only when the *message itself* is ambiguous, not when *you* are. If the message is decidable but you are not sure of the answer, skip the row entirely.
- The reply you would write is not actually a 1–5 word complete answer (for `terminal`) or a clean placeholder (for `continue` / `unable_to_determine`).
- The user message uses real-world identifiers, secrets, names, or contact details that look like genuine personal data. Use realistic but fictional substitutes.

Quality over quantity. Emitting the minimum 100 well is far more valuable than emitting 200 with weak rows.

## Worked Examples

These illustrate shape only. Do not copy any string from these examples into a generated row.

Terminal — phatic:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nhi\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"Hi.\",\"reason\":\"The latest message can be fully answered with a short reply.\"}"}]}
```

Terminal — tiny self-contained question:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat is 9 minus 4?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"5.\",\"reason\":\"The latest message can be fully answered with a short reply.\"}"}]}
```

Terminal — trivial transformation:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nspell mississippi\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"M-I-S-S-I-S-S-I-P-P-I.\",\"reason\":\"The latest message can be fully answered with a short reply.\"}"}]}
```

Terminal — acknowledgement closer:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nperfect, that's all I needed\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"Glad it helped.\",\"reason\":\"The latest message can be fully answered with a short reply.\"}"}]}
```

Continue — implicit task:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the failing tests and fix the smallest thing causing them\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"I'll check.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

Continue — needs lookup:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat's the weather right now?\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"Let me check.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

Continue — courtesy plus request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthanks for that, also can you double-check the totals against the source\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"On it.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

Continue — attachment-driven, message would otherwise be terminal:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsummarize this\n\nAttachments:\n- Attachment 1:\n  filename: q3-board-deck.pdf\n  mime_type: application/pdf"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"Reading now.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

Continue — multi-message, latest is amending prior request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\ndraft a one-paragraph kickoff note for the migration team for tomorrow.\n\nMessage 2 (target):\nrole: user\ntext:\nactually make it two paragraphs\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"I'll update it.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

Unable to determine — ambiguous fragment:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthat one but cleaner\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"unable_to_determine\",\"reply\":\"I need context.\",\"reason\":\"The latest message is too unclear to classify confidently.\"}"}]}
```

Boundary pair — bare thanks vs thanks + request (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthanks, that covers it\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"terminal\",\"reply\":\"Anytime.\",\"reason\":\"The latest message can be fully answered with a short reply.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nthanks, that covers it — also pull the latest numbers from the dashboard\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"terminality\":\"continue\",\"reply\":\"On it.\",\"reason\":\"The latest message requires downstream work beyond a short reply.\"}"}]}
```

## Appendix — Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. It is provided so you understand what context the model already has when it sees a training example. **Do not reuse strings from this appendix in generated training records.** Doing so will leak the runtime prompt's example phrasings into the training data and contaminate evaluation.

```
You are the preflight classifier for an AI assistant handoff system.

Decide whether the current normalized request can stop now or must be routed.

Return ONLY valid JSON matching:
{"terminality":"terminal|continue|unable_to_determine","reply":"<short user-facing line>","reason":"<one sentence>"}

Values:
- "terminal": reply is the final assistant response, and answering needs nothing beyond the message itself — no context, data, tools, or memory.
- "continue": the latest user message requires substantive assistant work.
- "unable_to_determine": too unclear to classify confidently; routing still continues.

reply semantics:
- reply is the user-facing line.
- Keep it tiny and human, usually 1 to 5 words.
- For "terminal", reply with the final answer itself.
- For "continue" and "unable_to_determine", acknowledge briefly without answering.
- Prefer "Let me check." when no specific short phrase fits.
- Do not ask for clarification.

Selection guide:
- The discriminator is which mode the reply field needs to be in for this message. Ask: can a 1–5 word reply, written from the message alone, fully serve as the assistant's complete answer?
- Yes → reply is in answer mode → choose "terminal".
- No, because the answer would not fit in a short reply, or because answering needs context, data, tools, or memory → reply is in placeholder mode → choose "continue".
- Too unclear to apply the test confidently → choose "unable_to_determine".
- When a message mixes courtesy with a substantive request, the request decides → choose "continue".
- When uncertain whether the user expects work → choose "continue".

Constraints:
- Return JSON only.
- For "continue" and "unable_to_determine", reply must not sound like the final answer.
- Do not mention routing, handoff, classifiers, models, tools, or downstream planning.
```
