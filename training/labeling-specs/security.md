# Security Labeling Spec

Security classifies prompt injection, unsafe action, permission, and data exposure risk. It is advisory and does not replace deterministic controls.

Manifest: `../../src/classifiers/security/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

Emit safety:

```json
{"reason":"...","confidence":0.9,"safety":{"decision":"needs_review","risk_level":"suspicious","signals":["instruction_attack"]}}
```

When the request should be blocked, emit:

```json
{"reason":"...","confidence":0.9,"safety":{"decision":"block","risk_level":"high_risk","signals":["unsafe_tool_or_action"]}}
```

## Risk Levels

- `normal`: no meaningful risk signal.
- `suspicious`: risk signal exists, but downstream can continue with caution.
- `high_risk`: block or require caller policy intervention.
- `unknown`: classifier cannot assess.

`normal` and `unknown` must have no signals. `suspicious` and `high_risk` must include at least one signal.

Use `decision: "allow"` for normal routing, `decision: "needs_review"` when the caller should clarify, escalate, or fail closed, and `decision: "block"` for high-risk requests that should not continue downstream.
