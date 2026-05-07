# Tools Training Guide

This is the classifier-specific companion to `adapters/README.md` for generating tool-family training data. Use it with the shared README preamble; this file contains only the tools-specific label rules, distributions, boundaries, and examples.

Append output to `adapters/tools.jsonl`. Hold back 10-20% as an eval split per the README's generation workflow.

## North Star

This classifier narrows the tool manifest sent to the frontier model. Loading every tool definition on every call is the single largest fixed-cost line item in a downstream prompt — tool schemas, descriptions, and parameter docs add up fast and get charged on every turn until the conversation ends. Every unneeded family included here is pure dead-weight tokens for the rest of the session.

The output populates `handoff.context.tools` with `needed: boolean` and `families: ToolFamily[]`. The downstream caller uses that to materialize a narrow tool manifest — `web` only, `workspace + developer_platforms`, no tools at all — instead of handing the model the full manifest. A small dedicated model exists for this so the manifest-narrowing decision happens before the frontier model sees the prompt; if you waited for the frontier model to "decide it doesn't need tools," you'd already have paid to include them.

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
- **Missing a required family (accuracy + latency impact).** Downstream has some tools but cannot complete the task, causing retries, partial work, or wrong work. "Apply the PR feedback to the local branch" with `workspace` but not `developer_platforms` means the model can edit but can't read the comments.
- **False positive family (cost impact, sometimes accuracy).** Downstream sees unnecessary tools, increasing every-turn prompt size by the family's full schema. The frontier model occasionally wanders into a wrong tool because it was offered. Cheaper per-call than a false negative but it pays *every turn for the rest of the conversation*, not just once.
- **Over-broad multi-family output (cost + accuracy impact).** Tool menus become noisy and may steer the downstream model into unnecessary actions. Three families when one is enough = three full schemas in the manifest forever.
- **`needed: true` with empty families or vice versa (correctness failure).** Hard contract violation. The two fields must always agree: `needed === true` ⟺ `families.length > 0`.

**Bias the training data accordingly.** Include tools whenever the request requires live state, files, apps, URLs, attachments, or external systems. Do not include a family simply because it could make a good answer better — convenience-only families are pure cost. Empty `families: []` is the correct answer for self-contained transformations, opinion, general knowledge, and code-only work without external lookup; do not hedge.

## Output Contract

```json
{"needed":false,"families":["workspace|web|communications|documents|spreadsheets|project_management|developer_platforms"],"reason":"<one sentence>"}
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

Use `workspace` for local files, repos, shell commands, git state, logs, local servers, tests, databases, environment variables, local runtime inspection, or anything on the user's machine/workspace.

Use `web` for current public facts, URLs, browsing, search, prices, schedules, news, public docs, public APIs, product pages, or internet lookup.

Use `communications` for email, calendar, contacts, chat, messages, meetings, invites, call notes, or communication-app state.

Use `documents` for PDFs, docs, slides, images, media, archives, text files, and non-tabular attachments that need inspection, extraction, conversion, summarization, redline, or comparison.

Use `spreadsheets` for spreadsheets, CSV/TSV files, workbook formulas, tables, tabular charts, or tabular data analysis.

Use `project_management` for tickets, tasks, boards, roadmaps, sprints, project plans, Linear/Jira/Asana/Trello-style workflows, or issue-tracking systems when treated as planning/project state.

Use `developer_platforms` for GitHub, GitLab, PRs, issues, CI/CD, package registries, cloud APIs, hosted logs, hosted developer services, or remote repo state.

## Selection Rules

- Return `needed:false` with an empty `families` array when the final message can be answered with the supplied window and without tools.
- Select every family required to complete the request, but omit families that would only be convenient.
- Attachments imply a family only when the user asks to inspect, use, convert, summarize, compare, or answer questions about attached content.
- Choose `spreadsheets` for tabular workbook/CSV attachments; choose `documents` for other attachment types when attached content must be inspected.
- Prefer `workspace` for local repo work and `developer_platforms` for hosted PR, issue, CI, or registry work; include both when the request needs local code and hosted platform state.
- Prefer `communications` for calendar/email/chat state even when the user asks for writing around that state.
- Prefer `web` for URLs and current public information, even if the task also includes a document or spreadsheet.

## Common LLM Failure Modes When Generating Tools Data

Watch for these:

1. **Adding `web` for ordinary knowledge.** "Explain DNS" needs no tools. "Look up the latest DNS RFC change" needs `web`.
2. **Treating attachment mentions without metadata as usable content.** If the user says "attached" but `Attachments: none`, tool need depends on whether downstream must inspect a missing attachment; the likely family may still be `documents` or `spreadsheets`, but examples should teach that metadata matters.
3. **Confusing local repo and hosted PR state.** Local tests/files/logs -> `workspace`; PR comments/CI/GitHub issue state -> `developer_platforms`; both when patching local code based on hosted feedback.
4. **Using `documents` for CSVs.** CSV/TSV/workbooks/tables are `spreadsheets`.
5. **Using `project_management` for all planning.** "Make a launch plan" is no tools. "Create the tasks in Linear" is `project_management`.
6. **Over-selecting convenience families.** If a direct answer can be produced from supplied context, do not add tools because they might enrich the answer.
7. **Output-shape drift.** Lock `needed`/`families` key order and make `needed` match family count exactly.

## Diversity Dimensions And Seed Lists

Sample combinations from these axes:

**Tool signal:** "look up", "latest", "current", URL, "attached", "open the file", "run tests", "check my email", "schedule", "create ticket", "review PR", "read logs", "update spreadsheet".

**No-tool signal:** explain, rewrite, brainstorm, compare from given text, summarize supplied paragraph, calculate simple math, draft standalone note, general advice.

**Surface:** terminal prompt, code review comment, Slack, email, calendar request, browser/chat, support form, issue tracker, mobile voice transcript.

**Attachment shape:** none, PDF, DOCX, slide deck, image, CSV, XLSX, ZIP, multiple mixed files, metadata missing size, user mentions an attachment but metadata is none.

**Multi-family combos:** web+spreadsheets, workspace+developer_platforms, communications+documents, communications+project_management, web+documents, workspace+web, project_management+developer_platforms.

**Multi-message windows:** **5–10% of rows.** Tool needs are usually evident from the latest message alone (a verb like "look up", "run", "open"; an attachment; a URL). Reserve multi-message rows for follow-up requests like "do that for the other file too" where the family is obvious from the prior turn but the latest turn is a bare directive.

**Domains:** engineering, data analysis, finance, legal/contracts, sales/customer support, marketing, recruiting, personal logistics, travel, education.

**User personas:** engineer, PM, analyst, lawyer, sales rep, recruiter, executive assistant, founder, student, support agent.

## Boundary Pairs (Generate These Adjacent In Output)

Generate 8-12 boundary pairs per batch. Each pair has near-identical wording but flips tool family needs.

Example pair shapes (do not copy these inputs verbatim):

- **No tools vs web.** "Explain what a rate limit is" -> no tools. "Look up the current rate limits for this API" -> `web`.
- **No tools vs workspace.** "Explain why tests can be flaky" -> no tools. "Run the flaky tests in this repo" -> `workspace`.
- **Documents vs spreadsheets.** "Summarize the attached PDF" -> `documents`. "Analyze the attached CSV" -> `spreadsheets`.
- **Workspace vs developer platforms.** "Fix the local failing test" -> `workspace`. "Review unresolved GitHub PR comments" -> `developer_platforms`. "Apply PR comments to this branch" -> both.
- **Planning no tools vs project management.** "Draft a sprint plan" -> no tools. "Create those sprint tasks in Jira" -> `project_management`.
- **Communications vs direct writing.** "Draft a polite reply to this pasted email" -> no tools if email text is supplied. "Find the email from Morgan and draft a reply" -> `communications`.
- **Attachment metadata absent vs present.** "Summarize this" with a PDF attachment -> `documents`. Same text with no attachment and no supplied object -> no tools for this classifier only if there is no actual inspectable content available.

## Gotchas

- "Explain DNS" needs no tools.
- "Look up the latest DNS RFC change" needs `web`.
- "Run tests" needs `workspace`.
- "Review PR comments and patch the local branch" needs `developer_platforms` and `workspace`.
- "Analyze attached CSV" needs `spreadsheets`, not `documents`.
- "Summarize attached PDF" needs `documents`.
- "Find emails from Alex and draft replies" needs `communications`.
- "Create a task in Linear" needs `project_management`.
- "Use the usual vendor" may need memory, but tools only if ordering, lookup, communications, or external state is required.
- Do not include `web` just because a question could be researched online.
- Do not include `documents` just because the user asks for writing. Documents means file-like artifact inspection or editing.

## Generation Instructions

When generating a batch:

- **Row count:** minimum 100, hard cap 200.
- **Family-count distribution (per 100):** 30-40 no-tool rows, 40-50 single-family rows, 15-25 multi-family rows.
- **Family coverage:** at least 8 examples of each family per 100 rows; include both easy and boundary cases.
- **Multi-family coverage:** include at least 3 examples each of `workspace`+`developer_platforms`, `web`+`documents`, `web`+`spreadsheets`, and `communications`+one other family.
- **Attachment rows:** 15-20% of rows, covering documents and spreadsheets separately.
- **Multi-message windows:** 5–10% of rows. Mostly follow-up directives that inherit the family from the prior turn.
- **Boundary pairs:** 8-12 pairs per batch, emitted on adjacent lines.

**Per-record self-check (HARD GATE -- do not emit on failure):**

1. Apply every hard gate from `adapters/README.md`.
2. Parsed assistant JSON has exactly three keys: `needed`, `families`, and `reason`.
3. `needed` is `true` exactly when `families.length > 0`.
4. `families` contains only allowed values, no duplicates, ordered by the family order in the Output Contract unless a worked example already shows the same combination.
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

Workspace:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the test suite and fix the failing upload test\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"workspace\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Spreadsheet plus web:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare the attached pricing CSV against the current public pricing page\n\nAttachments:\n- Attachment 1:\n  filename: pricing.csv\n  mime_type: text/csv"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"web\",\"spreadsheets\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Developer platform plus workspace:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\napply the unresolved GitHub PR comments to this local branch\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"workspace\",\"developer_platforms\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Communications plus documents:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nfind the contract Anna emailed yesterday and summarize the renewal terms\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"communications\",\"documents\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

Boundary pair -- planning vs project-management action:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn this launch idea into a five-task sprint plan\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":false,\"families\":[],\"reason\":\"The request can be handled without exposing tool families.\"}"}]}
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nturn this launch idea into five tasks and add them to our sprint board\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"project_management\"],\"reason\":\"The selected tool families are required to complete the request.\"}"}]}
```

## Appendix -- Runtime System Prompt (Reference Only, Do Not Copy)

This is the system prompt the production runtime sends to Gemma at inference time. **Do not reuse strings from this appendix in generated training records.**

```
You are the tool family classifier for an AI assistant handoff system.

Decide which broad tool families should be exposed to the downstream model for the current normalized request.

Return ONLY valid JSON matching:
{"needed":false,"families":["workspace|web|communications|documents|spreadsheets|project_management|developer_platforms"],"reason":"<one sentence>"}

Values:
- "workspace": choose this for local files, source code, shell commands, git state, logs, local servers, or runtime inspection.
- "web": choose this for current public facts, URLs, browsing, search, prices, schedules, news, docs, or other internet lookup.
- "communications": choose this for email, calendar, contacts, chat, meetings, invites, or messages.
- "documents": choose this for attached files and file-like artifacts that need inspection, extraction, conversion, or summarization, including PDFs, docs, slides, images, media, archives, and text-heavy files.
- "spreadsheets": choose this for spreadsheets, CSV/TSV files, tables, formulas, workbook analysis, or tabular charts.
- "project_management": choose this for tickets, tasks, boards, issue trackers, roadmaps, sprints, or planning systems.
- "developer_platforms": choose this for GitHub, GitLab, PRs, issues, CI/CD, package registries, cloud APIs, or hosted developer services.

Selection guide:
- Return `needed:false` with an empty `families` array when the final message can be answered with the supplied window and without tools.
- Select every family likely needed to complete the request, but omit families that would only be convenient.
- Attachments imply a family when the user asks to inspect, use, convert, summarize, compare, or answer questions about attached content.
- Choose "spreadsheets" for tabular workbook/CSV attachments; choose "documents" for other attachment types when attached content must be inspected.
- Prefer "workspace" for local repo work and "developer_platforms" for hosted PR, issue, CI, or registry work; include both when the request needs local code and hosted platform state.
- Set needed to true exactly when families contains at least one value.

Constraints:
- Return JSON only.
- Return tool families, not individual tools.
- Do not include duplicate values.
```
