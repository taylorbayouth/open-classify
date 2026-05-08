# Generation Guides

Per-classifier training-data generation guides:

```txt
guides/preflight.md
guides/routing.md
guides/conversation_history.md
guides/memory_retrieval_queries.md
guides/tools.md
guides/model_specialization.md
guides/security.md
```

Pair each guide with `../README.md` (the shared generation preamble) when prompting a frontier LLM to generate training data. The README supplies the cross-classifier hard rules; each guide supplies the classifier-specific label boundaries, distributions, diversity dimensions, and worked examples.

These guides are also useful as a human reference when curating eval rows by hand — the failure-mode discussion and boundary-pair examples apply to evals just as much as to training data.
