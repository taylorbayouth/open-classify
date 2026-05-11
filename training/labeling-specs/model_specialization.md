# Model Specialization Labeling Spec

Model specialization recommends the capability axis used by the model resolver. It does not emit model ids or tiers.

Manifest: `../../src/classifiers/model_specialization/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

When confident, emit:

```json
{"reason":"...","confidence":0.9,"routing":{"specialization":"coding"}}
```

Omit `routing.specialization` when the best specialization is unclear.

## Values

- `chat`: conversational or general assistant behavior.
- `writing`: drafting, editing, tone, summarization, and communication.
- `reasoning`: analysis, comparison, diagnosis, math, or judgment.
- `planning`: task decomposition, scheduling, sequencing, and coordination.
- `coding`: code reading, writing, debugging, tests, repos, or developer tooling.
- `instruction_following`: exact transformations, extraction, formatting, or constrained operations.
