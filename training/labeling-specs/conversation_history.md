# Conversation History Labeling Spec

Conversation history decides whether the supplied visible conversation window contains the context needed by the downstream model, and how many prior visible messages are useful.

Manifest: `../../src/classifiers/conversation_history/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

Emit one context status:

```json
{"reason":"...","confidence":0.9,"context":{"status":"sufficient","include_prior_messages":2}}
```

## Status Values

- `standalone`: latest user message is enough by itself.
- `sufficient`: the supplied conversation window contains all needed context; include the indicated number of prior messages.
- `insufficient`: the task needs older or missing context not present in the supplied conversation window.
- `unknown`: classifier cannot tell.

Use `include_prior_messages` only with `status: "sufficient"`. Count whole prior messages immediately before the target message.
