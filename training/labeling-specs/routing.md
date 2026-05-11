# Routing Labeling Spec

Routing recommends downstream execution mode and catalog tier. It does not choose concrete model ids.

Manifest: `../../src/classifiers/routing/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

When confident, emit:

```json
{"reason":"...","confidence":0.9,"routing":{"execution_mode":"tool_assisted","model_tier":"frontier_fast"}}
```

Omit uncertain routing fields rather than inventing a value.

## Execution Mode

- `direct`: answer can be produced in a single downstream model call without tools.
- `tool_assisted`: this turn needs tools or external state.
- `workflow`: durable, recurring, multi-stage, or long-running work.

## Model Tier

- `local_fast`: simple, low-stakes, cheap response.
- `local_strong`: ordinary reasoning or writing where local quality should be enough.
- `frontier_fast`: stronger hosted model for consequential, ambiguous, or quality-sensitive requests.
- `frontier_strong`: hardest reasoning, high stakes, expert judgment, complex coding, or tasks where a weak answer is costly.
