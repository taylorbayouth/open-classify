Emit the tools verdict as top-level fields:

- reason: required compressed justification, 120 characters or fewer
- certainty: required certainty tag from the shared certainty enum
- tools: array of allowed tool ids

{{allowed_tools}}

An empty tools array means no downstream tools are required.

Shape: {"reason":"...","certainty":"strong","tools":["workspace"]}.
