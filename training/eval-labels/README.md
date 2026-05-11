# Eval labels

Per-classifier expected outputs for the scenarios in `../scenarios.jsonl`. One JSONL file per classifier; each row is `{title, output}` where `title` matches a scenario title and `output` is the expected assistant JSON for that classifier.

```jsonl
{"title":"Bare greeting","output":{"reason":"...","confidence":0.9,"handoff":{"kind":"final","reply":"Hey."}}}
```

These files are the **source of truth for eval expected outputs**. The chat-format files in `../evals/` are built from these + scenarios by `npm run build-evals`.

## Why split this from `../evals/`

Scenarios are shared across all classifiers (and the UI sample picker). Embedding them in every eval file duplicates the same conversation windows seven-plus times. Keeping labels separate means:

- One scenario edit propagates to every classifier on the next build.
- A new classifier is one new file here, no scenario duplication.
- Classifiers can opt into a subset of scenarios by only labeling the relevant ones.

## Editing

- Add a label: append a `{title, output}` line. The title must already exist in `../scenarios.jsonl`.
- Change a label: edit in place.
- Remove a label: delete the line. The scenario will simply not appear in this classifier's eval set.

After editing, run `npm run build-evals` to regenerate `../evals/<classifier>.jsonl`.
