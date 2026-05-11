# Tools Labeling Spec

Tools decides whether downstream work needs tool access and which configured tool families should be exposed.

Manifest: `../../src/classifiers/tools/manifest.json`

## Output Shape

Always emit `reason` and `confidence`.

Emit:

```json
{"reason":"...","confidence":0.9,"tools":{"required":true,"families":["workspace"]}}
```

Use only families declared in the manifest. When no tools are needed, use `required: false` and an empty family list.

## Boundaries

- Required: current web data, files, documents, spreadsheets, communications, project management, repositories, or external system actions.
- Not required: conceptual explanations, pure writing from supplied context, simple calculations, and questions answerable from the message alone.
