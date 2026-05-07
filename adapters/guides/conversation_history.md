# Conversation History Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating conversation-history training data. Use it with the shared README preamble; this file contains only the conversation-history-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/conversation_history.jsonl`. Hold back 10–20% as an eval split per the README's generation workflow.

## North Star

Of the seven classifiers, this one is most directly responsible for the size of the visible-history portion of the downstream prompt. Every prior message it asks the caller to include is a chunk of tokens charged at frontier prices on every downstream turn that follows. Every prior message it leaves out is context the frontier model never gets to see. The classifier's job is to find the smallest visible suffix that lets the downstream model produce a *different and better* answer than it would with zero history.

Its outputs populate three parts of the handoff object: `context.conversation.prior_messages_needed` (the count), `context.conversation.messages` (the actual slice, populated by the runner from that count), and `context.conversation.needs_unseen_history` (a flag the caller uses to decide whether to widen the window or trigger memory retrieval). It does not slice messages itself — it emits a count and a reason, and a deterministic runner does the work.

A small dedicated model exists for this rather than letting the frontier model decide because the decision happens *before* the frontier model sees anything. By the time the frontier model could reason about how much history it needs, you've already paid to give it the wrong amount.

## Quick-Start (Human Curator)

A row is one JSON line. The user message wraps the conversation window; the assistant message is the classifier's JSON output, and nothing else. Pick the smallest count of prior visible messages that would meaningfully change the downstream answer, and set the four flags consistently.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":true,\"refers_to_history\":false,\"prior_messages_needed\":0,\"needs_unseen_history\":false,\"reason\":\"The latest message can be handled without prior messages.\"}"}]}
```

## What We Are Fine Tuning For

This classifier produces a five-field structured judgment about how much visible context the downstream model needs:

- It detects messages that stand alone (no prior turns required to route or answer well).
- It detects references to visible prior content ("that", "the second one", "make it shorter", "use the above").
- It picks the smallest sufficient count of visible prior messages — no more, no less, with a small upward bias when uncertain.
- It detects when the useful context lives *outside* the supplied window — in saved memory, in older project history, in a stripped/omitted earlier turn, or in another thread.
- It explains the choice in one sentence under 200 characters.

The runner converts `prior_messages_needed: N` into the actual N-message recent suffix. Training data only carries the count. Do not attempt to populate a `relevant_conversation_history` array in the assistant JSON — the contract has five keys, and that array is filled in downstream by deterministic code, not by the classifier.

## What Failure Costs In Production

This classifier touches all three impact axes from the README's Cost-Of-Error Vocabulary, often at once:

- **False low (`prior_messages_needed: 0` when 2 are needed).** Accuracy impact: the frontier model loses the referent — "make that shorter" with no draft, "use the second one" with no list — and either guesses, asks a clarifying question, or produces something off-target. Latency impact: the user has to repeat themselves or correct the answer, doubling the round-trip count.
- **False high (`prior_messages_needed: 5` when 0 are needed).** Cost impact: every one of those extra messages is tokens spent at frontier prices for no gain. Accuracy impact: the frontier model anchors on stale context that's no longer relevant, producing an answer that ignores the latest message's pivot. This is the most common subtle failure on standalone messages.
- **False `needs_unseen_history: false` when memory or older context is needed.** Accuracy impact: the frontier model misses the user's saved preferences, prior decisions, or "usual" patterns and gives a generic answer. The user's own history was the whole reason they didn't restate the context.
- **False `needs_unseen_history: true` on a self-contained message.** Latency impact: the caller fires a memory-retrieval round-trip that returns nothing useful. Cost impact: the eventual frontier prompt gets padded with low-relevance memory hits.
- **Inconsistent four-field combinations.** If `is_standalone: true` but `refers_to_history: true`, the downstream caller sees contradictory signals and has to pick one. Train the model to keep the four flags coherent.

**Bias the training data accordingly.** When a careful reader is on the boundary between counts, err one message higher. The cost of one extra prior message in the prompt is small; the cost of losing the referent is large. The exception is when the latest message is clearly self-contained — then `prior_messages_needed: 0` is the correct floor; do not pad it "just in case."

## Output Contract

```json
{"is_standalone":true,"refers_to_history":false,"prior_messages_needed":0,"needs_unseen_history":false,"reason":"<one sentence>"}
```

- `is_standalone` (required): boolean. True only when prior messages would not materially change routing or the downstream answer.
- `refers_to_history` (required): boolean. True when the latest message contains lexical or semantic references to prior conversation content.
- `prior_messages_needed` (required): non-negative integer. The smallest count of visible prior messages (excluding the latest) the downstream model should receive. Use the recent suffix; do not skip messages in the middle. The runner converts the count into the actual slice.
- `needs_unseen_history` (required): boolean. True when useful or required context appears to be outside the supplied window — stripped, omitted, in saved memory, in another thread, or in older project history.
- `reason` (required): compact one-sentence explanation, under 200 characters.

JSON key order: `is_standalone`, `refers_to_history`, `prior_messages_needed`, `needs_unseen_history`, `reason`. No extra keys. No whitespace inside the assistant JSON.

## The Four-Field Coherence Rules

The four boolean/numeric fields interact. Train the model to honor these combinations and avoid the contradictory ones:

| `is_standalone` | `refers_to_history` | `prior_messages_needed` | `needs_unseen_history` | When to use |
|---|---|---|---|---|
| true  | false | 0   | false | Self-contained question or task; no references; no useful unseen context |
| false | true  | ≥1  | false | References visible prior content; the needed messages are in the window |
| false | true  | 0   | true  | References content not visible (memory, older session, "usual") |
| false | true  | ≥1  | true  | References both visible and unseen content (mixed) |
| false | false | 0   | true  | No references but the message is incomplete without unseen context (e.g., a bare command with no antecedent in the window) |
| false | false | ≥1  | false | Rare — message doesn't reference prior content but downstream still benefits from seeing the recent thread (e.g., a continuation that builds on tone/style) |

Forbidden combinations the model should never emit:

- `is_standalone: true` with any of `refers_to_history: true`, `prior_messages_needed > 0`, or `needs_unseen_history: true`. Standalone means standalone.
- `refers_to_history: true` with `prior_messages_needed: 0` and `needs_unseen_history: false`. If it refers to history, the history must be either visible (count ≥ 1) or unseen (flag true).

## Common LLM Failure Modes When Generating Conversation History Data

Watch for these — they are the most frequent ways generated batches go wrong:

1. **Defaulting every multi-message row to `prior_messages_needed: 1`.** This trains the model to ignore message-count signal entirely. Vary the count: bare references ("make it shorter") need 1; option-pick references ("use the second one") often need 2 or more so the options and the recommendation are both visible; long planning threads can legitimately need 4–6.
2. **Over-using `needs_unseen_history: true` as a hedge.** This flag means "useful context is *outside* the supplied window." It is not a fallback for "I'm not sure how many messages to include." Use it only when the latest message points at something demonstrably absent: "the usual", "what we discussed last week", "our standard", "everything we agreed", a bare command with no visible antecedent.
3. **Treating any pronoun as a history reference.** "It's raining, should I bring an umbrella" uses "it" but is fully self-contained. The discriminator is whether the pronoun's referent must come from prior conversation.
4. **Counting the latest message in `prior_messages_needed`.** The latest target message is always excluded from the count. A two-message window with a target needing the prior turn is `prior_messages_needed: 1`, not 2.
5. **Trying to populate `relevant_conversation_history` in the JSON.** That field exists in the result interface but is filled by the runner from the count. Training rows have exactly five keys: `is_standalone`, `refers_to_history`, `prior_messages_needed`, `needs_unseen_history`, `reason`.
6. **Cribbing the worked-example phrasings.** Do not reuse the strings shown later in this guide ("make it shorter", "use the usual hotel", "the second one", etc.) as your training inputs. Treat them as illustrative shapes; generate fresh surface forms.
7. **Output-shape drift.** Letting the assistant JSON vary in key order, whitespace, capitalization, or boolean/integer literal style. Lock the shape; vary only the user message.

## The Discriminator

A two-part test decides every row:

> Would the latest message produce a *different and better* downstream answer if we included N prior messages? If yes, what is the smallest N that achieves the improvement?

- **N = 0 and answer is the same.** → `is_standalone: true`, all other flags false, count 0.
- **N ≥ 1 and the needed messages are visible in the window.** → `is_standalone: false`, `refers_to_history: true` if there's a lexical reference (else false), count = the smallest sufficient suffix length, `needs_unseen_history: false`.
- **The needed context is not in the window.** → `is_standalone: false`, `refers_to_history: true` if the message points at it, count = 0 (or ≥ 1 if mixed), `needs_unseen_history: true`.

When in doubt between two adjacent counts, choose the higher one. A wasted message is cheap; a lost referent is expensive.

## Input Shapes by Label

Pick training shapes by what the input *is*, not by the label. The label follows from the shape.

### Standalone (true / false / 0 / false)

- **Self-contained questions.** "What are the tradeoffs of SQLite and Postgres for an offline-first app?" — full context in the message itself.
- **Self-contained tasks.** "Write a 60-word LinkedIn post announcing our seed round" — the parameters are all present.
- **General-knowledge requests.** "Explain why bread rises when it bakes."
- **Live-tool requests with self-contained scope.** "What's the current price of bitcoin in USD?"
- **Single-message work with a clear new topic.** Even after a long conversation, a fresh "Let's switch gears — explain how DNS works" is standalone.

### Visible-history reference (false / true / N≥1 / false)

- **Edits and refinements.** "Make that shorter", "more formal", "drop the second paragraph".
- **Option picks.** "Use the second one", "go with option B", "the first option you suggested".
- **Continuations.** "Continue with that plan", "now do the same for the staging environment".
- **Corrections and amendments.** "Actually, change the date to Tuesday", "no, swap the first and third items".
- **Follow-up questions on a visible answer.** "Why does that approach work better?".

### Unseen-history reference (false / true / 0 or N≥1 / true)

- **"Usual" and "preferred" patterns.** "Book my usual hotel", "use my normal investor-update format", "the client we always use for this kind of work".
- **Prior decision recall.** "What did we decide for the launch checklist?", "based on our agreed plan".
- **Stripped or older-session reference.** "Continue with the migration plan we discussed last week", "use the spec from the Tuesday meeting".
- **Bare commands with no visible antecedent.** A single message "Continue with the migration plan" in a window with no prior migration plan visible.
- **Mixed visible + unseen.** "Use the second option from above, but apply our standard formatting" — the second option is visible (count ≥ 1), the standard formatting lives elsewhere (`needs_unseen_history: true`).

### Malformed / opaque (false / false / count of all visible / true)

- **Garbled fragments.** Cannot be parsed as a coherent request.
- **Contradictory or empty.** Fragments where a careful reader cannot extract intent.
- **Default conservative read.** When the message is too opaque to classify cleanly, set `is_standalone: false`, include the visible prior messages in the count, set `needs_unseen_history: true`, and explain the conservatism in `reason`.

## Diversity Dimensions And Seed Lists

When generating a batch, sample combinations from these axes rather than free-generating. Free generation collapses to median quickly.

**Surface (where the message came from):** slack DM, slack channel, email body, web chat, voice transcript, terminal/CLI prompt, SMS, mobile push reply, support form submission, Discord, mobile keyboard with autocorrect, voice-to-text with disfluencies.

**Length:** 1 word, 2–4 words, one short sentence, two sentences, a paragraph, a multi-paragraph rant, a mid-thought fragment.

**Register:** formal corporate, casual peer, terse expert, friendly customer, frustrated/curt, multilingual code-switching, ALL CAPS, no punctuation lowercase, dictation-style with run-on phrasing, typo-heavy.

**Domain:** software engineering, data analysis, product strategy, marketing copy, finance/accounting, legal review, medical/health (general), education, creative writing, household/personal logistics, travel planning, customer support, scientific research.

**Reference type:** none (standalone), pronoun ("it", "that", "this"), ordinal ("the second", "the first option"), demonstrative phrase ("that draft", "the above"), continuation verb ("continue", "keep going"), edit verb ("make it shorter", "tighten that"), "usual"/"preferred"/"standard", named prior decision, time-anchored ("from yesterday", "last week"), thread-anchored ("from the Tuesday call").

**User personas:** senior engineer, junior dev, founder, designer, PM, marketer, recruiter, parent, student, scientist, sales rep, support agent, writer, lawyer.

**Multi-message windows:** target **30–40% of conversation-history rows**. This is the highest multi-message percentage of any classifier because reasoning about visible history is the classifier's core competency. Within multi-message rows, vary the prior-message count: 30% should need exactly 1 prior message, 30% need exactly 2, 25% need 3–4, 15% need 5 or more (long planning threads, multi-option discussions).

## Boundary Pairs (Generate These Adjacent In Output)

Boundary pairs are the highest-leverage signal for a small model. Each pair is two records with a near-identical user message but flipped flags. Emit them on adjacent lines. Generate **8–12 such pairs per batch** (more than other guides — this classifier needs the boundary signal most).

Example pair shapes (do not copy these inputs verbatim — generate new ones following these shapes):

- **Standalone vs follow-up edit.** "Write a one-paragraph kickoff note for the migration team" → standalone, count 0. With a prior assistant draft visible, "make that two paragraphs" → not standalone, refers to history, count 1.
- **Visible-history vs unseen-history on similar surfaces.** With a visible plan in the window, "continue with the plan above" → count = (number of plan messages), `needs_unseen_history: false`. Same words with no visible plan, "continue with the migration plan" → count 0, `needs_unseen_history: true`.
- **Single reference vs multi-reference.** "Use option B" with two options visible → count 1 if the options are in one assistant turn, count 2+ if user and assistant turns both contain the options. "Use the second one but with the formatting from the first" → count covers both options.
- **Pronoun standalone vs pronoun referential.** "It's been a long week, give me a one-line motivational close" → standalone (the pronoun is generic). "It needs to be more direct" → not standalone, refers to history.
- **"Usual" with vs without supporting visible context.** "Use my usual investor-update format" with no visible format → `needs_unseen_history: true`, count 0. Same words after the user previously pasted their format inline → `needs_unseen_history: false`, count = (the messages containing the format).
- **Continuation verb with vs without target.** Bare "continue" with no visible thread → opaque, conservative read. "Continue" after a clear pause in a visible plan → not standalone, count = (recent plan messages).
- **Memory-pointing vs visible-pointing on the same surface.** "Like we agreed" with the agreement not in the window → `needs_unseen_history: true`. "Like we agreed above" with the agreement in the window → count = (agreement messages), `needs_unseen_history: false`.

## Gotchas

- The latest target message is **never** counted in `prior_messages_needed`. Always exclude it.
- A pronoun is not automatically a history reference. "It's raining, what should I wear" is standalone.
- "Continue" is the most ambiguous word in this classifier. With visible thread → use the visible count. With no visible thread → `needs_unseen_history: true`.
- Two visible options + a recommendation + "use the second one" usually needs `prior_messages_needed: 2` or 3, not 1, so the model can see both options *and* the recommendation when picking.
- "Same as before" / "the usual" / "what we agreed" always implies `needs_unseen_history: true` if the referent isn't in the window.
- A long planning conversation followed by "summarize that" needs the whole plan visible — count is large, not 1.
- A new topic mid-conversation is standalone even if the prior turns were related. Topic shift breaks history dependency.
- Do not pretend to populate `relevant_conversation_history` in the assistant JSON. Five keys, no more, no less.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200. Stop at the cap; redundancy past that is just cost.
- **Label distribution (per 100):**
  - 30–35 standalone (true / false / 0 / false).
  - 25–30 visible-history reference (false / true / N≥1 / false).
  - 15–20 unseen-history-needed (false / true / 0 or N≥1 / true).
  - 10–15 mixed (visible + unseen, false / true / N≥1 / true).
  - 5–10 malformed/opaque conservative reads.
- **Within visible-history rows:** vary the count — 30% need 1, 30% need 2, 25% need 3–4, 15% need 5+.
- **Multi-message windows:** **30–40% of rows** (highest of any classifier). Many standalone rows can still be multi-message — show the model that prior content present in the window does not always mean the latest message depends on it.
- **Boundary pairs:** 8–12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE — do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly five keys: `is_standalone`, `refers_to_history`, `prior_messages_needed`, `needs_unseen_history`, `reason`.
3. The four flag values satisfy a row in the Four-Field Coherence Rules table (no forbidden combinations).
4. `prior_messages_needed` is a non-negative integer; the latest target message is not counted.
5. `reason` is short, factual, and consistent with the four flag values.
6. The user message is not a near-duplicate of any prior row in this batch and not a string copied from this guide's worked examples or appendix.

If any check fails, regenerate the record or skip it. Do not emit a guess.

## Stop Conditions

Refuse to emit a record when:

- You cannot decide between two adjacent prior_messages_needed counts even after applying the upward-bias rule. Skip the row.
- You cannot decide between `needs_unseen_history: true` and false for a clearly self-contained message. The message is probably standalone — re-read it.
- The user message uses real-world identifiers, secrets, names, or contact details that look like genuine personal data. Use realistic but fictional substitutes.

Quality over quantity. Emitting the minimum 100 well is far more valuable than emitting 200 with weak rows.

## Worked Examples

These illustrate shape only. Do not copy any string from these examples into a generated row.

Standalone — self-contained question:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nwhat are the practical tradeoffs between sqlite and postgres for an offline-first mobile app\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":true,\"refers_to_history\":false,\"prior_messages_needed\":0,\"needs_unseen_history\":false,\"reason\":\"The latest message is fully self-contained and needs no prior context.\"}"}]}
```

Standalone — pronoun without history dependence:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nit's been a tough week, give me a one-line pep talk\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":true,\"refers_to_history\":false,\"prior_messages_needed\":0,\"needs_unseen_history\":false,\"reason\":\"The pronoun is generic and the request stands alone.\"}"}]}
```

Visible-history — single-message edit:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: assistant\ntext:\nHere's a draft kickoff note: \"Team — heads up that the migration starts Monday morning. Sync with infra on rollback. Ping me if anything blocks you.\"\n\nMessage 2 (target):\nrole: user\ntext:\ntighten that to two short sentences\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":1,\"needs_unseen_history\":false,\"reason\":\"The latest message edits the visible prior draft.\"}"}]}
```

Visible-history — option pick needing multiple prior messages:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\ngive me three subject-line options for the renewal email\n\nMessage 2 (context):\nrole: assistant\ntext:\nOption A: \"Quick check-in on your renewal\". Option B: \"Your renewal is up for review\". Option C: \"Two minutes on next year\".\n\nMessage 3 (target):\nrole: user\ntext:\nuse option b but make it warmer\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":2,\"needs_unseen_history\":false,\"reason\":\"The pick references both the request and the options list.\"}"}]}
```

Unseen-history — bare reference to absent context:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncontinue with the migration plan from last tuesday\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":0,\"needs_unseen_history\":true,\"reason\":\"The migration plan is referenced but not visible in the supplied window.\"}"}]}
```

Unseen-history — "usual" pattern:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nbook my usual hotel for the boston trip next week\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":0,\"needs_unseen_history\":true,\"reason\":\"The request depends on a saved travel preference outside the window.\"}"}]}
```

Mixed — visible + unseen:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: assistant\ntext:\nProposed agenda: 1) Status, 2) Risks, 3) Next steps.\n\nMessage 2 (target):\nrole: user\ntext:\ngo with that agenda but apply our standard meeting-note formatting\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":1,\"needs_unseen_history\":true,\"reason\":\"The agenda is visible; the formatting standard is outside the window.\"}"}]}
```

Standalone within a long window — topic shift:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nhelp me debug this auth middleware\n\nMessage 2 (context):\nrole: assistant\ntext:\nThe issue is the session check runs before the token refresh; swap the order.\n\nMessage 3 (target):\nrole: user\ntext:\nseparate question — what's the best way to estimate the cost of running a small redis cluster on aws\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":true,\"refers_to_history\":false,\"prior_messages_needed\":0,\"needs_unseen_history\":false,\"reason\":\"The latest message starts a new topic that does not depend on the prior debug thread.\"}"}]}
```

Long-thread continuation — large prior count:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nlet's plan the q3 launch\n\nMessage 2 (context):\nrole: assistant\ntext:\nStart with goals — what are we trying to prove?\n\nMessage 3 (context):\nrole: user\ntext:\nactivation rate on the new pricing tier\n\nMessage 4 (context):\nrole: assistant\ntext:\nGot it. Then: instrument the funnel, ship the price page, run the email, monitor for two weeks, iterate.\n\nMessage 5 (target):\nrole: user\ntext:\nturn that whole conversation into a one-page launch brief i can share with the team\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":4,\"needs_unseen_history\":false,\"reason\":\"The brief must reflect the full plan visible in the prior turns.\"}"}]}
```

Malformed conservative read:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nso the thing about that other thing\n\nMessage 2 (target):\nrole: user\ntext:\nyeah do that one\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":false,\"prior_messages_needed\":1,\"needs_unseen_history\":true,\"reason\":\"The message is too referential to classify cleanly; include visible context and flag unseen need.\"}"}]}
```

Boundary pair — visible vs unseen on the same surface (emit adjacent):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: assistant\ntext:\nDraft launch checklist:\n1. Freeze code Friday.\n2. Smoke-test staging Saturday.\n3. Cut release Sunday morning.\n\nMessage 2 (target):\nrole: user\ntext:\ncontinue with that checklist and add owner names\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":1,\"needs_unseen_history\":false,\"reason\":\"The checklist to extend is visible in the prior assistant turn.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncontinue with the launch checklist and add owner names\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"is_standalone\":false,\"refers_to_history\":true,\"prior_messages_needed\":0,\"needs_unseen_history\":true,\"reason\":\"The checklist is referenced but not visible in the supplied window.\"}"}]}
```

## Appendix — Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. It is provided so you understand what context the model already has when it sees a training example. **Do not reuse strings from this appendix in generated training records.** Doing so will leak the runtime prompt's example phrasings into the training data and contaminate evaluation.

```
You are the conversation history classifier for an AI assistant handoff system.

Recommend how much visible prior conversation history should be included with the latest normalized user message, and whether unseen history may be needed.

Return ONLY valid JSON matching:
{"is_standalone":true,"refers_to_history":false,"prior_messages_needed":0,"needs_unseen_history":false,"reason":"<one sentence>"}

Fields:
- "is_standalone": true when the latest message can be routed and answered well without any prior visible messages.
- "refers_to_history": true when the latest message points to prior conversation content, such as "that", "it", "the second one", "use the above", "continue", or "same as before".
- "prior_messages_needed": number of visible prior messages to include with the latest message. Exclude the latest message from this count. Use the smallest sufficient recent suffix, but err high when uncertain.
- "needs_unseen_history": true when useful or required context appears to be outside the supplied window, stripped, omitted, in saved memory, in another thread, or in older project history.
- "reason": compact one-sentence diagnostic explanation for the recommendation.

Selection guide:
- Classify only the latest user message. Earlier messages are context evidence only, not new requests.
- Count only visible prior messages in "prior_messages_needed"; do not count the latest user message.
- "prior_messages_needed" is converted by the caller into a concrete suffix of visible sanitized messages.
- If the latest message is standalone, set "is_standalone": true, "refers_to_history": false, "prior_messages_needed": 0, and "needs_unseen_history": false.
- If visible prior messages are needed, set "is_standalone": false and "prior_messages_needed" to the smallest recent suffix that preserves the needed context.
- If the user invokes older decisions, preferences, saved facts, prior sessions, "usual", "everything we discussed", or context not visible in the supplied window, set "needs_unseen_history": true.
- If visible history may help but no exact boundary is clear, include more visible prior messages rather than fewer.
- If the message is malformed or too opaque to classify, set "is_standalone": false, include all visible prior messages, and set "needs_unseen_history": true.

Constraints:
- Return JSON only.
- Use exactly these five keys.
- "prior_messages_needed" must be a non-negative integer.
- Keep "reason" under 200 characters.
```
