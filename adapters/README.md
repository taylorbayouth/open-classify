# Adapter Training Files

This folder contains append-only JSONL training files, one per classifier:

```txt
adapters/preflight.jsonl
adapters/routing.jsonl
adapters/conversation_history.jsonl
adapters/memory_retrieval_queries.jsonl
adapters/tools.jsonl
adapters/message_and_attachment_digest.jsonl
adapters/security.jsonl
```

Use this README for shared mechanics, then use the classifier-specific guide for the file you are populating:

```txt
adapters/guides/preflight.md
adapters/guides/routing.md
adapters/guides/conversation_history.md
adapters/guides/memory_retrieval_queries.md
adapters/guides/tools.md
adapters/guides/message_and_attachment_digest.md
adapters/guides/security.md
```

Each adapter output must match its classifier's schema. Do not train the seven adapters on a combined classifier object.

Each line is one chat-format training record. Add new examples by appending a single JSON object on a new line.

## Two Ways to Generate Training Data

The guides serve two consumers:

1. **LLM-as-generator (primary).** Pass this README first, then exactly one classifier-specific guide, to a frontier LLM. This README is the shared generation preamble; the guide supplies the classifier-specific label boundaries, distribution, diversity dimensions, and examples. The output is ready-to-append JSONL.
2. **Human curator (secondary).** Read the same guide top-to-bottom and append rows by hand. Every guide opens with a quick-start summary so a human can add a single row in about a minute without reading the full generation harness.

Both consumers must produce records that satisfy the same hard rules below.

## Shared Generator Prompt

Use this shared instruction block for every classifier-specific training-data generation run:

You are creating high-quality chat-format JSONL training data for Open Classify, a seven-classifier handoff system running local fine-tuned Gemma4 adapters. The adapters must be fast, local, and cheap, but they must not pretend certainty where the input is genuinely unclear.

The production goal is:

- Most ordinary requests classify locally and route efficiently.
- Big or expensive downstream routes are the conservative default for consequential uncertainty, classifier uncertainty, or classifier failure.
- Big or expensive routes should still be the minority because the local classifiers are accurate on clear inputs.
- If any classifier has an explicit `unable_to_determine` option, use it only when the input itself is not classifiable by a careful reader.
- Classifier-specific uncertainty must not be hidden by guessing a cheap route, no-tool result, empty memory query, or normal security posture.
- `preflight` is special: a `terminal` result aborts downstream routing entirely, so false-terminal examples are much more dangerous than false-continue examples.

When generating data, optimize for boundary learning rather than easy volume. Include realistic false-positive and false-negative traps, adjacent boundary pairs, varied surfaces, and compact schema-perfect assistant outputs.

The prompt bundle for generation is:

```txt
1. adapters/README.md
2. adapters/guides/<classifier>.md
```

Emit only raw JSONL records for the selected classifier. Do not emit Markdown fences, commentary, headings, combined classifier objects, or rows for other classifiers.

## Training Record Strategy

Keep records lean and focused on the distinct input-to-output mapping.

The runtime system prompt already carries the invariant classifier instructions, so adapter records should not repeat long prose such as "classify the final message" or "return JSON only" in every user message. Repeating those instructions burns training tokens without adding much example diversity.

The user message must preserve the Open Classify input shape:

```text
Conversation window:
Message 1 (target):
role: user
text:
thanks, that's all

Attachments:
none
```

This keeps examples compact while still teaching the model that classification targets the final conversation-window message and that attachments are represented as metadata.

Single-message windows are preferred for simple examples. Use multi-message windows only when the label depends on context, such as conversation history selection, memory hints, or digest resolution. Use `Attachments: none` unless the classifier label depends on attachment metadata.

The assistant message must contain only the classifier's JSON result. Do not include explanations, Markdown, comments, or combined outputs from other classifiers.

Before generating a batch, read the matching guide and decide the target label mix. Prefer examples that stress the classifier's boundaries over easy duplicates.

## Hard Rules That Apply To Every Record

These invariants apply to every record in every classifier file. The guides assume this README is included in the generation prompt, so do not copy this section into generated records or duplicate it inside new guide text.

1. **System prompt is byte-identical across every record.** The exact string is:
   ```
   Return only valid JSON for this classifier. Do not answer the user.
   ```
   Do not vary capitalization, punctuation, or whitespace. Small instruct models like Gemma will spuriously learn that the system message carries information if it varies. Lock it.

2. **JSON-in-JSON escaping must be consistent.** Each record is a single JSON object whose `messages[*].content` fields are themselves strings. Inside those strings:
   - Newlines are the escape sequence `\n` (two characters: backslash + n), never a literal newline byte.
   - Inner quotes inside the assistant's JSON output are escaped as `\"`.
   - Backslashes are escaped as `\\`.
   - No tabs, no `\r`, no Unicode-escape forms unless the source character actually requires them.

   **Why this matters specifically for Gemma:** Gemma 3/4 tokenizers handle JSON whitespace and quote-escaping inconsistently. Mixed escaping styles inside JSON strings are one of the top causes of "model learned the format almost-but-not-quite" failures on small instruct models. One inconsistent record can teach a wrong escape pattern. Pick one style (the one shown in the existing JSONL files and worked examples) and use it for every line.

3. **Output-format determinism.** Across every record:
   - Same JSON key order (the order shown in the guide's Output Contract).
   - Same whitespace inside the assistant JSON (no spaces after `:` or `,`, since the existing rows use the compact form).
   - Same enum casing exactly as defined (e.g., `tool_assisted`, not `Tool_Assisted` or `tool-assisted`).
   - All variance lives in the user message surface form, not in the assistant output shape.

4. **Each record is exactly one line.** No pretty-printing. No trailing newline inside a record. Append one `\n` between records. Never split a record across lines.

5. **Per-record self-check before emit (hard gate).** Before writing any record:
   - The full line must `JSON.parse` cleanly as a single object.
   - The inner assistant `content` must `JSON.parse` cleanly as the classifier's contract object.
   - The system prompt must be byte-identical to rule 1.
   - If any check fails, fix it or skip the record. Do not emit a guess.

6. **Anti-leakage.** Do not reuse strings from worked examples in the guide or from the runtime system prompts in `src/prompts.ts`. The examples illustrate shape, not content. Generated training records must use new surface forms; otherwise the fine-tuned model's eval set is contaminated by its own prompt.

## Generation Workflow

When using the LLM-as-generator path:

1. Pick the classifier file you want to grow (e.g., `adapters/security.jsonl`).
2. Pass this README and the corresponding guide (e.g., `adapters/guides/security.md`) to a frontier LLM as the user prompt.
3. The LLM emits ready-to-append JSONL according to the guide's row-count target and label distribution.
4. **Hold back 10–20% of the generated batch as an eval split** before appending. Keep the eval rows in a file or location that is *not* part of the training input (the project does not yet have an established convention for this — pick a path and document it the first time you do this). Without an eval split you cannot measure whether new data improved or regressed Gemma's behavior.
5. Append the remaining training rows to `adapters/<classifier>.jsonl`.
6. Re-train the adapter, point `adapter-models.json` at the new model name, and run the eval split through the new adapter to confirm the change moved the metric in the right direction.

The eval-split discipline matters most for the five currently-empty classifier files (`conversation_history`, `memory_retrieval_queries`, `tools`, `message_and_attachment_digest`, `security`), where the next batch of generated data will define the model's behavior with no historical baseline to compare against.

Runtime model selection is configured separately in `adapter-models.json` at the project root. Ollama chat requests select model names; they do not attach these JSONL files directly per request.
