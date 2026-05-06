# Message And Attachment Digest Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating message-and-attachment-digest training data. Use it with the shared README preamble; this file contains only the digest-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/message_and_attachment_digest.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## Quick-Start (Human Curator)

A row is one JSON line. Write a compact snake_case slug, one factual short summary of the latest request, and one metadata-only summary per attachment.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"summarize_request\",\"summary\":\"The user wants the request summarized.\",\"attachments\":[]}"}]}
```

## What We Are Fine Tuning For

This classifier creates a compact, factual, database-friendly digest of the latest request and attachment metadata.

It should be useful for logs, UI labels, trace summaries, search, and observability. It should not solve the task, route it, assess safety, infer hidden attachment contents, or mention classifier internals.

The digest should:

- Name the user's intent.
- Resolve obvious referents from the supplied window when unambiguous.
- Preserve attachment metadata exactly when available.
- Be short enough for database and UI display fields.
- Stay neutral when the request is unclear.

## What Failure Costs In Production

- **Invented attachment content.** Logs claim a file contains facts the classifier never saw. This is the worst digest failure.
- **Wrong referent resolution.** Observability points to the wrong task or object, making downstream debugging harder.
- **Overlong summaries or slugs.** UI and trace displays become noisy, and validation may fail.
- **Too-generic digest.** Operators cannot tell what request was routed.

**Bias the training data accordingly.** Summaries should be specific but factual. Attachment summaries must use metadata only. When uncertain, encode uncertainty rather than guessing.

## Output Contract

```json
{"slug":"<snake_case_slug>","summary":"<short summary>","attachments":[{"filename":"<name>","size_bytes":123,"mime_type":"<type>","metadata_summary":"<1-2 sentence metadata-derived summary>"}]}
```

- `slug` (required): short stable snake_case label based on the user's intent. Use lowercase letters, digits, and underscores only.
- `summary` (required): one factual plain-text sentence describing the user's message, 160 characters or fewer.
- `attachments` (required): one object per attachment in the input. Use `[]` when there are no attachments.
- Attachment object key order: `filename`, then `size_bytes` if available, then `mime_type` if available, then `metadata_summary`.
- Attachment `metadata_summary`: one plain-text sentence derived from metadata only (you do not see file contents), 160 characters or fewer.

JSON key order: `slug`, then `summary`, then `attachments`. No extra keys. No whitespace inside the assistant JSON.

## Field Rules

`slug` should be short, stable, snake_case, and action-oriented. Good slugs look like `summarize_contract`, `fix_upload_tests`, `schedule_design_review`, or `compare_pricing_csv`.

`summary` describes what the user asks, not what the assistant should answer. It should not include Markdown, route names, model names, or tool names unless the user explicitly mentions a tool as the object of the request.

`attachments` should include one object per attachment. Preserve available `filename`, `mime_type`, and `size_bytes`. Omit optional keys that are absent from input metadata; do not invent them.

For referential messages, resolve the referent only when the supplied conversation window makes it unambiguous. If not, keep the digest neutral.

For messages without attachments, use an empty attachments array.

## Common LLM Failure Modes When Generating Digest Data

Watch for these:

1. **Inventing file contents.** Metadata says `contract.pdf`; summary cannot say it is a vendor MSA unless the user text or filename makes that clear.
2. **Solving the task.** The summary should say the user wants a contract summarized; it should not summarize the contract.
3. **Making slugs too long.** Do not encode every noun. Two to five words is usually enough.
4. **Dropping partial attachment metadata.** If `size_bytes` is absent, omit it; do not set `0` or `null`.
5. **Over-resolving ambiguous referents.** "Use the other one" with no context should remain uncertain.
6. **Output-shape drift.** Lock key order, compact JSON, slug format, and attachment object shape.

## Slug Rules

- Prefer verb_object, such as `review_contract`, `summarize_sales_csv`, `draft_reply`, `fix_login_bug`, `schedule_sync`.
- Use the most specific stable object available from the latest message, supplied context, or filename.
- Keep slugs usually 2-5 words.
- Use `unclear_request`, `use_other_option`, or similar neutral slugs for ambiguous inputs.
- Do not include dates, IDs, hashes, personal names, or long filenames unless they are essential to distinguish the object.

## Summary Rules

- Start with "The user wants..." for consistency unless another concise phrasing is clearly better.
- Keep under 160 characters.
- Use plain text only.
- Do not include hidden assumptions, downstream actions, classifier labels, or model names.
- Resolve referents only from supplied context.
- Preserve uncertainty: "The user refers to another option, but the option is not provided in the window."

## Attachment Summary Rules

- Use only metadata and user-visible text.
- Mention content unavailable when only metadata exists.
- For filename-only attachments: "An attachment named <filename>; contents are unavailable to this classifier."
- For MIME-only attachments: "An attachment with MIME type <mime_type>; contents are unavailable to this classifier."
- For partial metadata, preserve exactly what exists.
- Never infer spreadsheet rows, PDF clauses, image content, audio transcript, or archive contents.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes:

**Intent:** explain, rewrite, summarize, compare, review, fix, debug, draft, schedule, remind, search, analyze, convert, extract, translate, brainstorm, approve, cancel, unclear reference.

**Conversation shape:** single clear request, long messy request, referential follow-up, prior assistant answer followed by correction, ambiguous one-liner, multi-message with resolved object.

**Attachment shape:** none, single PDF, single CSV, XLSX, DOCX, slide deck, image, archive, audio/video, multiple files, partial metadata, user mentions an attachment but metadata is none.

**Domain:** engineering, legal/contracts, finance, sales, marketing, recruiting, education, personal logistics, travel, customer support, healthcare admin, research.

**Register:** formal, casual, terse, typo-heavy, voice-to-text, frustrated, multilingual fragment.

**User personas:** engineer, founder, PM, analyst, lawyer, recruiter, teacher, support lead, executive assistant, student.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 6-10 boundary pairs per batch. Each pair has near-identical surface form but changes referent or attachment handling.

Example pair shapes (do not copy these inputs verbatim):

- **No attachment vs attachment metadata.** "Summarize this" with no supplied object -> uncertain digest. Same message with PDF metadata -> summarize attached PDF.
- **Filename-specific vs generic.** "Review the contract" with `vendor-msa.pdf` -> slug can mention vendor contract. "Review the file" with opaque filename -> generic file-review slug.
- **Resolved vs unresolved referent.** Prior context says option A is monthly billing; target "use that one" -> resolved summary. Same target alone -> unclear option.
- **CSV vs PDF.** "Analyze the attached file" with CSV metadata -> spreadsheet/data digest. Same with PDF metadata -> document digest.
- **Long messy request vs compact digest.** Multi-sentence ramble about fixing one bug -> short `fix_<bug>` slug and one-sentence summary.

## Gotchas

- Do not answer the user.
- Do not say a file contains something unless metadata, filename, or conversation text says so.
- Do not include Markdown in summaries.
- Do not create long slugs from every noun in the request.
- Do not mention classifier, routing, model, or tool details.
- Keep attachment summaries boring and factual.
- If the request is unclear, make the slug and summary reflect that uncertainty without guessing.
- Preserve available attachment fields; omit unavailable optional fields.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Attachment distribution (per 100):** 45-55 no attachments, 25-35 one attachment, 10-15 multiple attachments, 5-10 partial-metadata attachment cases.
- **Referential rows:** 15-20 rows, split between resolved and unresolved referents.
- **Messy-to-compact rows:** at least 15 rows where the user message is long but the digest stays short.
- **Boundary pairs:** 6-10 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly three keys: `slug`, `summary`, and `attachments`.
3. `slug` matches snake_case and is not overly long.
4. `summary` is one plain-text sentence under 160 characters.
5. Each attachment output preserves available `filename`, `size_bytes`, and `mime_type`; optional absent fields are omitted, not invented.
6. Attachment summaries are metadata-only and under 160 characters.
7. The user message is not a near-duplicate of any prior row in this batch and not copied from this guide's examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- The digest would require inventing attachment contents. Generalize from metadata or skip.
- The row uses real personal data, real customer names, real emails, or secrets. Use realistic fictional substitutes.
- A summary exceeds 160 characters and cannot be shortened without losing the user's intent.
- You cannot resolve a referent but the output pretends it is resolved.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

Simple request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain why bread rises when it bakes\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"explain_bread_rising\",\"summary\":\"The user wants an explanation of why bread rises when it bakes.\",\"attachments\":[]}"}]}
```

Attachment metadata:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsummarize the attached contract and flag anything unusual\n\nAttachments:\n- Attachment 1:\n  filename: vendor-contract.pdf\n  mime_type: application/pdf\n  size_bytes: 248912"},{"role":"assistant","content":"{\"slug\":\"summarize_vendor_contract\",\"summary\":\"The user wants the attached vendor contract summarized and checked for unusual items.\",\"attachments\":[{\"filename\":\"vendor-contract.pdf\",\"size_bytes\":248912,\"mime_type\":\"application/pdf\",\"metadata_summary\":\"A PDF attachment named vendor-contract.pdf; contents are unavailable to this classifier.\"}]}"}]}
```

Partial attachment metadata:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nextract the action items from this file\n\nAttachments:\n- Attachment 1:\n  filename: notes.txt"},{"role":"assistant","content":"{\"slug\":\"extract_action_items\",\"summary\":\"The user wants action items extracted from the attached file.\",\"attachments\":[{\"filename\":\"notes.txt\",\"metadata_summary\":\"An attachment named notes.txt; contents are unavailable to this classifier.\"}]}"}]}
```

Resolved context:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nI need a reminder for my Tuesday meeting with Dave.\n\nMessage 2 (target):\nrole: user\ntext:\nmake it 3 PM\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"update_meeting_reminder_time\",\"summary\":\"The user wants the Tuesday meeting reminder with Dave set to 3 PM.\",\"attachments\":[]}"}]}
```

Unclear request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nuse the other one instead\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"use_other_option\",\"summary\":\"The user refers to using another option, but the option is not provided in the window.\",\"attachments\":[]}"}]}
```

Boundary pair -- no attachment vs attached PDF:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsummarize this and tell me the main risk\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"summarize_unspecified_item\",\"summary\":\"The user wants an unspecified item summarized and checked for the main risk.\",\"attachments\":[]}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsummarize this and tell me the main risk\n\nAttachments:\n- Attachment 1:\n  filename: renewal-agreement.pdf\n  mime_type: application/pdf"},{"role":"assistant","content":"{\"slug\":\"summarize_renewal_agreement\",\"summary\":\"The user wants the attached renewal agreement summarized and checked for the main risk.\",\"attachments\":[{\"filename\":\"renewal-agreement.pdf\",\"mime_type\":\"application/pdf\",\"metadata_summary\":\"A PDF attachment named renewal-agreement.pdf; contents are unavailable to this classifier.\"}]}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the message and attachment digest generator for an AI assistant handoff system.

Create a compact, factual digest of the current normalized request and any attachment metadata.

Return ONLY valid JSON matching:
{"slug":"<snake_case_slug>","summary":"<short summary>","attachments":[{"filename":"<name>","size_bytes":123,"mime_type":"<type>","metadata_summary":"<1-2 sentence metadata-derived summary>"}]}

Field semantics:
- "slug": a short stable snake_case label for the request, based on the user's intent.
- "summary": a short factual description of what the user is asking for, suitable for a database short-string field. Resolve obvious referents from the supplied conversation window when they are unambiguous.
- "attachments": one object per attachment in the input, preserving available filename, size_bytes, and mime_type fields.
- Attachment "metadata_summary": a short database-friendly description derived from metadata only. You do not see file contents.

Selection guide:
- Name the action and object in the slug, such as "review_contract" or "summarize_sales_csv".
- Summaries should describe the user's message, not solve it or describe the classification task.
- Keep top-level summary and attachment summaries to one plain-text sentence, 160 characters or fewer.
- For referential messages, include the resolved current-window object when the supplied context makes it clear.
- For attachments with only metadata, describe the metadata and whether contents are available to this classifier.
- For messages without attachments, use an empty attachments array.

Constraints:
- Return JSON only.
- Use snake_case for slug.
- Use plain text, not markdown.
- Do not invent attachment contents.
```
