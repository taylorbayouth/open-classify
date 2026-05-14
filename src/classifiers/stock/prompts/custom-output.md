Custom classifiers must return one JSON object with:

- reason: required compressed justification, 120 characters or fewer
- certainty: required number from 0 to 1
- output: required JSON value that matches this classifier's output_schema

Shape: {"reason":"...","certainty":0.75,"output":<value>}.
