# Memory Retrieval Queries Labeling Spec

Memory retrieval emits custom output only. The aggregator validates and passes this output through but never interprets it.

Manifest: `../../src/classifiers/memory_retrieval_queries/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

Emit:

```json
{"reason":"...","confidence":0.9,"output":{"queries":["user client update style"]}}
```

Use an empty query array when memory is not useful.

## Boundaries

Suggest memory queries for preferences, prior decisions, recurring personal/business context, established style, known projects, or user-specific facts. Do not suggest memory queries for general factual knowledge, data already present in the conversation window, or one-off external research.
