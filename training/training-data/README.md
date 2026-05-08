# Training Data

Your fine-tuning data lives here, one JSONL file per classifier:

```txt
training-data/preflight.jsonl
training-data/routing.jsonl
training-data/conversation_history.jsonl
training-data/memory_retrieval_queries.jsonl
training-data/tools.jsonl
training-data/model_specialization.jsonl
training-data/security.jsonl
```

**These files are gitignored.** Fine-tuning data is user-specific — you generate your own using the per-classifier guides in `../guides/` and the shared workflow in `../README.md`. The repo ships only the guides and the eval sets.

If you clone this repo and want to start training, follow the generation workflow in `../README.md` to populate the JSONL files here, then run your fine-tuning pipeline against them.
