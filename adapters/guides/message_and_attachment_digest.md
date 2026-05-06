# Message And Attachment Digest Training Guide

Use this guide when adding rows to `adapters/message_and_attachment_digest.jsonl`.

## What We Are Fine Tuning For

Train this classifier to create a compact, factual database-friendly digest of the latest request and attachment metadata. It should summarize intent, not solve the task or make routing decisions.

The digest should be useful for logs, UI labels, trace summaries, and downstream observability.

## Output Contract

```json
{"slug":"<snake_case_slug>","summary":"<short summary>","attachments":[{"filename":"<name>","size_bytes":123,"mime_type":"<type>","summary":"<1-2 sentence summary>"}]}
```

## Field Rules

`slug` should be short, stable, snake_case, and action-oriented. Good slugs look like `summarize_contract`, `fix_upload_tests`, or `schedule_design_review`.

`summary` should be one factual plain-text sentence, ideally 160 characters or fewer. It describes what the user asks, not what the assistant should answer.

`attachments` should include one object per attachment. Preserve available `filename`, `mime_type`, and `size_bytes`. The attachment summary must use metadata only. Do not invent file contents.

For no attachments, return an empty attachments array.

For referential messages, resolve the referent only when the supplied conversation window makes it unambiguous.

## Batch Coverage

Include:

- Short simple messages.
- Long messy messages that need compact summaries.
- Multi-message windows where context resolves "that" or "it".
- Attachments with complete metadata.
- Attachments with partial metadata.
- Multiple attachments.
- Messages where the user mentions an attachment but metadata is `none`.
- Ambiguous messages that still need a neutral digest.

## Gotchas

- Do not answer the user.
- Do not say a file contains something unless metadata or conversation text says so.
- Do not include Markdown in summaries.
- Do not create long slugs from every noun in the request.
- Do not mention classifier, routing, model, or tool details.
- Keep attachment summaries boring and factual.
- If the request is unclear, make the slug and summary reflect that uncertainty without guessing.

## Example Rows

Simple request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nexplain why bread rises when it bakes\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"explain_bread_rising\",\"summary\":\"The user wants an explanation of why bread rises when it bakes.\",\"attachments\":[]}"}]}
```

Attachment metadata:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nsummarize the attached contract and flag anything unusual\n\nAttachments:\n- Attachment 1:\n  filename: vendor-contract.pdf\n  mime_type: application/pdf\n  size_bytes: 248912"},{"role":"assistant","content":"{\"slug\":\"summarize_vendor_contract\",\"summary\":\"The user wants the attached vendor contract summarized and checked for unusual items.\",\"attachments\":[{\"filename\":\"vendor-contract.pdf\",\"size_bytes\":248912,\"mime_type\":\"application/pdf\",\"summary\":\"A PDF attachment named vendor-contract.pdf; contents are unavailable to this classifier.\"}]}"}]}
```

Resolved context:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (context):\nrole: user\ntext:\nI need a reminder for my Tuesday meeting with Dave.\n\nMessage 2 (target):\nrole: user\ntext:\nmake it 3 PM\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"update_meeting_reminder_time\",\"summary\":\"The user wants the Tuesday meeting reminder with Dave set to 3 PM.\",\"attachments\":[]}"}]}
```

Unclear request:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nuse the other one instead\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"slug\":\"use_other_option\",\"summary\":\"The user refers to using another option, but the option is not provided in the window.\",\"attachments\":[]}"}]}
```
