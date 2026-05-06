# Tools Training Guide

Use this guide when adding rows to `adapters/tools.jsonl`.

## What We Are Fine Tuning For

Train the tools classifier to expose only the broad tool families the downstream model is likely to need. It should not choose individual tools, route model tiers, or decide whether work is durable.

The desired behavior is precise but practical:

- Return no tools for fully self-contained requests.
- Include every necessary family for multi-source tasks.
- Omit families that are merely convenient.
- Use attachment metadata as a signal only when the user asks to use attachment contents.

## Output Contract

```json
{"needed":false,"families":["workspace|web|communications|documents|spreadsheets|project_management|developer_platforms"]}
```

When `families` is non-empty, `needed` must be `true`. When no tools are needed, return:

```json
{"needed":false,"families":[]}
```

## Family Rules

Use `workspace` for local files, repos, shell commands, git state, logs, local servers, tests, databases, or runtime inspection.

Use `web` for current public facts, URLs, browsing, search, prices, schedules, news, docs, public APIs, or internet lookup.

Use `communications` for email, calendar, contacts, chat, messages, meetings, invites, or call notes in communication apps.

Use `documents` for PDFs, docs, slides, images, media, archives, text files, and non-tabular attachments that need inspection, extraction, conversion, or summarization.

Use `spreadsheets` for spreadsheets, CSV/TSV, workbook formulas, tables, tabular charts, and tabular data analysis.

Use `project_management` for tickets, tasks, boards, roadmaps, sprints, project plans, or issue-tracking workflows.

Use `developer_platforms` for GitHub, GitLab, PRs, issues, CI/CD, package registries, cloud APIs, hosted logs, or hosted developer services.

## Batch Coverage

For a 100-row batch, include:

- 30 to 40 no-tool rows.
- 40 to 50 single-family rows.
- 15 to 25 multi-family rows.

Cover all families. Include hard boundaries such as workspace vs developer platform, documents vs spreadsheets, and web vs memory.

## Gotchas

- "Explain DNS" needs no tools.
- "Look up the latest DNS RFC change" needs `web`.
- "Run tests" needs `workspace`.
- "Review PR comments and patch the local branch" needs `developer_platforms` and `workspace`.
- "Analyze attached CSV" needs `spreadsheets`, not `documents`.
- "Summarize attached PDF" needs `documents`.
- "Find emails from Alex and draft replies" needs `communications`.
- "Create a task in Linear" needs `project_management`.
- "Use the usual vendor" may need memory, but tools only if ordering or lookup is required.
- Do not include `web` just because a question could be researched online.

## Example Rows

No tools:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nmake this sentence clearer: we maybe should possibly ship later\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":false,\"families\":[]}"}]}
```

Workspace:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\nrun the test suite and fix the failing upload test\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"workspace\"]}"}]}
```

Spreadsheet plus web:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\ncompare the attached pricing CSV against the current public pricing page\n\nAttachments:\n- Attachment 1:\n  filename: pricing.csv\n  mime_type: text/csv"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"web\",\"spreadsheets\"]}"}]}
```

Developer platform plus workspace:

```json
{"messages":[{"role":"system","content":"Return only valid JSON for this classifier. Do not answer the user."},{"role":"user","content":"Conversation window:\nMessage 1 (target):\nrole: user\ntext:\napply the unresolved GitHub PR comments to this local branch\n\nAttachments:\nnone"},{"role":"assistant","content":"{\"needed\":true,\"families\":[\"workspace\",\"developer_platforms\"]}"}]}
```
