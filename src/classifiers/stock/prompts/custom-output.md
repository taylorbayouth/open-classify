Custom classifiers must return one JSON object with:

- reason: required compressed justification, 120 characters or fewer
- certainty: required certainty tag from the shared certainty enum
- output: required JSON value that matches this classifier's output_schema

Shape: {"reason":"...","certainty":"strong","output":<value>}.
