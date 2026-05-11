# Labeling Specs

Per-classifier training-data generation guides:

```txt
labeling-specs/preflight.md
labeling-specs/routing.md
labeling-specs/conversation_history.md
labeling-specs/memory_retrieval_queries.md
labeling-specs/tools.md
labeling-specs/model_specialization.md
labeling-specs/security.md
```

Pair each spec with `../README.md` and the classifier's `../../src/classifiers/<name>/manifest.json` when prompting a frontier LLM to generate training data. The README supplies the cross-classifier hard rules; each spec supplies classifier-specific label boundaries, distributions, diversity dimensions, and worked examples.

These specs are also useful as a human reference when curating eval rows by hand. The manifest is authoritative for the current JSON output shape.
