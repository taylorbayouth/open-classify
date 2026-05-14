Emit the tools verdict as top-level fields:

- reason: required compressed justification, 120 characters or fewer
- certainty: required number from 0 to 1
- tools: array of allowed tool ids

{{allowed_tools}}

An empty tools array means no downstream tools are required.

Shape: {"reason":"...","certainty":0.75,"tools":["workspace"]}.
