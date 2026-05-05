# Adapter Training Files

This folder contains append-only JSONL training files, one per classifier:

```txt
adapters/preflight.jsonl
adapters/routing.jsonl
adapters/context_sufficiency.jsonl
adapters/memory_retrieval_queries.jsonl
adapters/tools.jsonl
adapters/message_and_attachment_digest.jsonl
adapters/security.jsonl
```

Each adapter output must match its classifier's schema. Do not train the seven adapters on a combined classifier object.

Each line is one chat-format training record. Add new examples by appending a single JSON object on a new line.

Runtime model selection is configured separately in `adapter-models.json` at the project root. Ollama chat requests select model names; they do not attach these JSONL files directly per request.
