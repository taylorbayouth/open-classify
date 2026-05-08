# Tools Training Guide

This is the classifier-specific companion to `training/README.md` for generating tool-family training data. Use it with the shared README preamble; this file contains only the tools-specific label rules, distributions, boundaries, and examples.

Append output to `training/training-data/tools.jsonl` (gitignored — it stays on your local machine). The shared eval set in `training/evals/tools.jsonl` is committed to the repo; do not append generated rows there.

## North Star

This classifier narrows the tool manifest sent to the frontier model. Loading every tool definition on every call is the single largest fixed-cost line item in a downstream prompt — tool schemas, descriptions, and parameter docs add up fast and get charged on every turn until the conversation ends. Every unneeded family included here is pure dead-weight tokens for the rest of the session.

The output populates `handoff.context.tools` with `needed: boolean` and `families: ToolFamily[]`. The downstream caller uses that to materialize a narrow tool manifest — `web` only, `code + files`, no tools at all — instead of handing the model the full manifest. A small dedicated model exists for this so the manifest-narrowing decision happens before the frontier model sees the prompt; if you waited for the frontier model to "decide it doesn't need tools," you'd already have paid to include them.

The classifier outputs broad families, not individual tool names. Tool-level decisions happen downstream once the manifest is loaded.

## Quick-Start (Human Curator)

A row is one JSON line. Pick only the broad tool families required for the downstream assistant to complete the latest request. Return no tools for self-contained work.

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\n<the user's message>\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":false,\"families\":[],\"reason\":\"The request can be handled without exposing tool families.\"}"}]}
```

## What We Are Fine Tuning For

The tools classifier decides which **broad tool families** should be exposed downstream. It does not choose individual tools, route model tiers, fetch memory, assess security, or decide whether work is durable.

The desired behavior is precise but practical:

- Return no tools for fully self-contained requests.
- Include every necessary family for multi-source tasks.
- Omit families that are merely convenient.
- Use attachment metadata as a signal only when the user asks to use attachment contents.
- Treat failure or uncertainty as expensive downstream escalation, so produce `needed:false` only when no tools are genuinely required.

## What Failure Costs In Production

Tagged with the README's Cost-Of-Error Vocabulary:

- **False negative (`needed:false` when tools are required) — accuracy + latency impact, worst tools-classifier failure.** Downstream hallucinates current facts, file contents, app state, or attachment contents because it lacks the tool to look them up. The user gets a confident wrong answer and either acts on it or has to re-prompt with explicit instructions, doubling the round-trip count.
- **Missing a required family (accuracy + latency impact).** Downstream has some tools but cannot complete the task, causing retries, partial work, or wrong work. "Apply the PR feedback to the local branch" with `files` but not `code` means the model can read files but can't inspect the PR comments.
- **False positive family (cost impact, sometimes accuracy).** Downstream sees unnecessary tools, increasing every-turn prompt size by the family's full schema. The frontier model occasionally wanders into a wrong tool because it was offered. Cheaper per-call than a false negative but it pays *every turn for the rest of the conversation*, not just once.
- **Over-broad multi-family output (cost + accuracy impact).** Tool menus become noisy and may steer the downstream model into unnecessary actions. Three families when one is enough = three full schemas in the manifest forever.
- **`needed: true` with empty families or vice versa (correctness failure).** Hard contract violation. The two fields must always agree: `needed === true` ⟺ `families.length > 0`.

**Bias the training data accordingly.** Include tools whenever the request requires live state, files, apps, URLs, attachments, or external systems. Do not include a family simply because it could make a good answer better — convenience-only families are pure cost. Empty `families: []` is the correct answer for self-contained transformations, opinion, general knowledge, and code-only work without external lookup; do not hedge.

## Output Contract

```json
{"needed":false,"families":["web|email_and_chat|calendar|files|docs_and_sheets|tasks_and_projects|code|business_apps"],"reason":"<one sentence>"}
```

- `needed` (required): boolean. Must be `true` exactly when `families` is non-empty.
- `families` (required): array of unique family strings drawn from the allowed list.
- `reason` (required): compact diagnostic explanation for why tool families are or are not needed, under 200 characters.

When no tools are needed, return exactly:

```json
{"needed":false,"families":[],"reason":"The request can be handled without exposing tool families."}
```

JSON key order: `needed`, then `families`, then `reason`. No extra keys. No whitespace inside the assistant JSON.

## Family Rules

Use `web` for current public facts, URLs, browsing, search, news, prices, public docs, public APIs, product pages, or internet lookup.

Use `email_and_chat` for email, Slack, Teams, Discord, iMessage, or any chat or messaging state — reading messages, finding threads, drafting replies to located messages.

Use `calendar` for calendar events, meeting scheduling, availability lookup, invites, reminders, Google Calendar, or Outlook calendar state.

Use `files` for Drive, Dropbox, Box, or local file system operations — opening, reading, moving, copying, uploading, or listing files when the content is not a document or spreadsheet being edited.

Use `docs_and_sheets` for Google Docs, Notion, Word, Google Sheets, Excel, Airtable, PDFs, slides, CSV/TSV, images, media, archives, or any attached file whose content must be read, edited, extracted, summarized, converted, or compared.

Use `tasks_and_projects` for Jira, Linear, Asana, Todoist, Trello, GitHub Issues, or any ticket, task, board, roadmap, sprint, or issue-tracking system when treated as project or planning state.

Use `code` for GitHub, GitLab, local repos, CI/CD pipelines, Vercel, AWS, cloud deployments, PRs, hosted registry state, shell commands, test execution, or local code inspection and editing.

Use `business_apps` for CRM systems (Salesforce, HubSpot), payment platforms (Stripe), design tools (Figma), analytics dashboards, HR systems, and other SaaS products not covered by the families above.

## Selection Rules

- Return `needed:false` with an empty `families` array when the final message can be answered with the supplied window and without tools.
- Select every family required to complete the request, but omit families that would only be convenient.
- Attachments imply a family only when the user asks to inspect, use, convert, summarize, compare, or answer questions about attached content; all attachment types use `docs_and_sheets`.
- Prefer `code` for both local repo work and hosted PR/CI work; include `files` when the request also requires reading or moving non-code files.
- Use `email_and_chat` for messaging state; use `calendar` for scheduling and event state; include both when the request spans messages and calendar.
- Prefer `web` for URLs and current public information even if the task also involves a document.
- Use `business_apps` only when the request requires interacting with a specific named SaaS product not covered by any other family.

## Common LLM Failure Modes When Generating Tools Data

Watch for these:

1. **Adding `web` for ordinary knowledge.** "Explain a rate limit" needs no tools. "Look up the current rate limits for this API" needs `web`.
2. **Treating attachment mentions without metadata as usable content.** If the user says "attached" but `Attachments: none`, there is no inspectable content; do not select `docs_and_sheets` unless the attachment metadata is present.
3. **Splitting what is now one family.** CSVs, PDFs, Word docs, images, and slides all land in `docs_and_sheets`. There is no longer a separate `spreadsheets` vs `documents` split.
4. **Using `calendar` for a scheduling email.** If the work is reading or sending a message, use `email_and_chat`. Use `calendar` only when actual event or availability state must be read or written.
5. **Using `tasks_and_projects` for generic planning.** "Draft a sprint plan" is no tools. "Create those tasks in Linear" is `tasks_and_projects`.
6. **Reaching for `business_apps` as a catch-all.** Only use it when a specific named SaaS outside the other families is involved. Generic "business task" does not trigger it.
7. **Using `files` for document editing.** `files` is for file system operations (listing, moving, uploading). Reading or editing a Google Doc or an Excel file is `docs_and_sheets`.
8. **Conflating `code` and `files`.** Local shell commands, tests, git ops, and PR reviews are `code`. Copying files on Dropbox is `files`. Include both only when both are genuinely needed.
9. **Over-selecting convenience families.** If a direct answer can be produced from supplied context, do not add tools because they might enrich the answer.
10. **Output-shape drift.** Lock `needed`/`families` key order and make `needed` match family count exactly.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes:

**Tool signal:** "look up", "latest", "current", URL, "attached", "open the file", "run tests", "check my email", "find the Slack message", "schedule", "create ticket", "review PR", "read logs", "update the sheet", "deploy", "log in Salesforce".

**No-tool signal:** explain, rewrite, brainstorm, compare from given text, summarize supplied paragraph, calculate simple math, draft standalone note, general advice.

**Surface:** terminal prompt, code review comment, Slack, email, calendar request, browser/chat, support form, issue tracker, mobile voice transcript.

**Attachment shape:** none, PDF, DOCX, slide deck, image, CSV, XLSX, ZIP, multiple mixed files, metadata missing size, user mentions an attachment but metadata is none.

**Multi-family combos:** `web`+`docs_and_sheets`, `code`+`files`, `email_and_chat`+`calendar`, `tasks_and_projects`+`code`, `email_and_chat`+`docs_and_sheets`, `web`+`email_and_chat`, `business_apps`+`email_and_chat`, `calendar`+`docs_and_sheets`.

**Domains:** engineering, data analysis, finance, legal/contracts, sales/customer support, marketing, recruiting, personal logistics, travel, education.

**User personas:** engineer, PM, analyst, lawyer, sales rep, recruiter, executive assistant, founder, student, support agent.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 8-12 boundary pairs per batch. Each pair has near-identical wording but flips tool family needs.

Example pair shapes (do not copy these inputs verbatim):

- **No tools vs web.** "Explain what a rate limit is" → no tools. "Look up the current rate limits for this API" → `web`.
- **No tools vs code.** "Explain why tests can be flaky" → no tools. "Run the flaky tests in this repo" → `code`.
- **email_and_chat vs calendar.** "Find the email where we agreed on Thursday" → `email_and_chat`. "Check if I'm free Thursday afternoon" → `calendar`. "Find that email and block the afternoon on my calendar" → both.
- **code vs files.** "Fix the failing unit test" → `code`. "Move all the PDFs from the Downloads folder to Drive" → `files`. "Apply the PR diff and archive the old docs" → both.
- **docs_and_sheets vs no tools.** "Summarize this pasted contract text" → no tools. "Summarize the attached contract PDF" → `docs_and_sheets`.
- **Planning no tools vs tasks_and_projects.** "Draft a sprint plan" → no tools. "Create those sprint tasks in Linear" → `tasks_and_projects`.
- **web vs business_apps.** "Look up Salesforce's current pricing" → `web`. "Pull the open opportunities from our Salesforce org" → `business_apps`.
- **email_and_chat vs direct writing.** "Draft a polite reply to this pasted email" → no tools if email text is supplied. "Find the email from Morgan and draft a reply" → `email_and_chat`.

## Gotchas

- "Explain DNS" needs no tools.
- "Look up the latest DNS RFC change" needs `web`.
- "Run tests" needs `code`.
- "Review PR comments and patch the local branch" needs `code`.
- "Analyze attached CSV" needs `docs_and_sheets`, not a separate spreadsheets family.
- "Summarize attached PDF" needs `docs_and_sheets`.
- "Find emails from Alex and draft replies" needs `email_and_chat`.
- "Block Thursday at 3pm on my calendar" needs `calendar`.
- "Find Alex's email and add the meeting to my calendar" needs `email_and_chat` + `calendar`.
- "Create a task in Linear" needs `tasks_and_projects`.
- "Log the deal in HubSpot" needs `business_apps`.
- "Move these files to the archive folder in Drive" needs `files`.
- "Open and edit the Q3 report in Google Docs" needs `docs_and_sheets`.
- Do not include `web` just because a question could be researched online.
- Do not include `docs_and_sheets` just because the user asks for writing. It means file or attachment content inspection or editing.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Family-count distribution (per 100):** 30-40 no-tool rows, 40-50 single-family rows, 15-25 multi-family rows.
- **Family coverage:** at least 8 examples of each family per 100 rows; include both easy and boundary cases.
- **Multi-family coverage:** include at least 3 examples each of `email_and_chat`+`calendar`, `code`+`files`, `web`+`docs_and_sheets`, `tasks_and_projects`+`code`, and `business_apps`+one other family.
- **Attachment rows:** 15-20% of rows, all using `docs_and_sheets`.
- **Single-message only:** every record must contain exactly one user message (`Message 1 (target)`). Do not generate multi-message windows for this classifier.
- **Boundary pairs:** 8-12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `training/README.md`.
2. Parsed assistant JSON has exactly three keys: `needed`, `families`, and `reason`.
3. `needed` is `true` exactly when `families.length > 0`.
4. `families` contains only allowed values from the 8-family list, no duplicates, ordered by the family order in the Output Contract unless a worked example already shows the same combination.
5. Every selected family is required, and no required family is missing.
6. `reason` is short, factual, and consistent with the selected families.
7. The user message is not a near-duplicate of any prior row in this batch and not copied from this guide's examples or appendix.

If any check fails, regenerate the record or skip it.

## Stop Conditions

Refuse to emit a record when:

- You cannot decide whether a family is required after applying the selection rules. Skip rather than guess.
- The row depends on a real external account, file path, email address, token, or customer name. Use realistic fictional substitutes.
- The output includes a family merely because it would be convenient. Remove it or skip.
- The attachment metadata contradicts the selected family and you cannot fix the row cleanly.

## Worked Examples

These illustrate shape only. Do not copy any string into a generated row.

No tools:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nmake this sentence clearer: we maybe should possibly ship later\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":false,\"families\":[],\"reason\":\"The request can be handled without exposing tool families.\"}"}]}
```

Code:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the test suite and fix the failing upload test\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"code\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Web plus docs_and_sheets:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare the attached pricing CSV against the current public pricing page\n\nAttachments:\n- Attachment 1:\n  filename: pricing.csv\n  mime_type: text/csv"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"web\",\"docs_and_sheets\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Code (covers both local repo and hosted PR state):

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\napply the unresolved GitHub PR comments to this local branch\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"code\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Email_and_chat plus docs_and_sheets:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nfind the contract Anna emailed yesterday and summarize the renewal terms\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"email_and_chat\",\"docs_and_sheets\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Email_and_chat plus calendar:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nfind the meeting invite Sarah sent and check if I have a conflict that afternoon\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"email_and_chat\",\"calendar\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Business_apps:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\npull the open opportunities from Salesforce and show me which ones close this quarter\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"business_apps\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Boundary pair -- planning vs tasks_and_projects action:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn this launch idea into a five-task sprint plan\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":false,\"families\":[],\"reason\":\"The request can be handled without exposing tool families.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn this launch idea into five tasks and add them to our sprint board\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"tasks_and_projects\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the tool family classifier for an AI assistant handoff system.

Decide which broad tool families should be exposed to the downstream model for the current normalized request.

Return ONLY valid JSON matching:
{"needed":false,"families":["web|email_and_chat|calendar|files|docs_and_sheets|tasks_and_projects|code|business_apps"],"reason":"<one sentence>"}

Values:
- "web": choose this for current public facts, URLs, browsing, search, news, prices, or internet lookup.
- "email_and_chat": choose this for email, Slack, Teams, Discord, iMessage, or any chat or messaging state.
- "calendar": choose this for calendar events, meeting scheduling, availability, Google Calendar, or Outlook.
- "files": choose this for Drive, Dropbox, Box, or local file system — opening, reading, moving, or inspecting files.
- "docs_and_sheets": choose this for Google Docs, Notion, Word, Google Sheets, Excel, Airtable, or any document or spreadsheet content including PDFs, slides, CSV, and media attachments.
- "tasks_and_projects": choose this for Jira, Linear, Asana, Todoist, Trello, GitHub Issues, or any ticket, task, board, or sprint state.
- "code": choose this for GitHub, GitLab, local repos, CI/CD, Vercel, AWS, deployments, shell commands, or test execution.
- "business_apps": choose this for CRM (Salesforce, HubSpot), payments (Stripe), design tools (Figma), or other SaaS not covered by the families above.

Selection guide:
- Return needed:false with an empty families array when the final message can be answered with the supplied window and without tools.
- Select every family likely needed to complete the request, but omit families that would only be convenient.
- Attachments imply a family when the user asks to inspect, use, convert, summarize, compare, or answer questions about attached content; all attachment types use "docs_and_sheets".
- Prefer "code" for both local repo work and hosted PR/CI work; include "files" when non-code files must also be read or moved.
- Use "email_and_chat" for messaging state; use "calendar" for scheduling and event state; include both when the request spans messages and calendar.
- Set needed to true exactly when families contains at least one value.

Constraints:
- Return JSON only.
- Return tool families, not individual tools.
- Do not include duplicate values.
```
