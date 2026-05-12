# Preflight Labeling Spec

Preflight decides whether the pipeline can answer immediately or should route downstream with an acknowledgement.

Manifest: `../../src/classifiers/preflight/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

Emit `handoff` only when there is a concrete handoff decision:

```json
{"reason":"...","confidence":0.9,"handoff":{"kind":"route","ack_reply":"I'll check."}}
```

Use `handoff.kind: "final"` only when the latest user message can be fully answered with a short, safe reply and no downstream model, tools, memories, or hidden context. Do not use `final` for rewriting, drafting, analysis, coding, research, or other generated work.

Use `handoff.kind: "route"` when downstream work should continue and a brief acknowledgement would help.

Omit `handoff` when the classifier cannot decide confidently.

## Boundaries

- Final: greetings, thanks, simple arithmetic, spelling, and closure messages that need no prior state.
- Route: tool use, web/current data, attachments, writing tasks, coding tasks, memory-dependent tasks, or any request needing real work.
- Unknown: ambiguous referents where the classifier cannot tell whether prior context would resolve the task.
