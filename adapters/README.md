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

Use this README for shared mechanics, then use the classifier-specific guide for the file you are populating:

```txt
adapters/guides/preflight.md
adapters/guides/routing.md
adapters/guides/context_sufficiency.md
adapters/guides/memory_retrieval_queries.md
adapters/guides/tools.md
adapters/guides/message_and_attachment_digest.md
adapters/guides/security.md
```

Each adapter output must match its classifier's schema. Do not train the seven adapters on a combined classifier object.

Each line is one chat-format training record. Add new examples by appending a single JSON object on a new line.

## Training Record Strategy

Keep records lean and focused on the distinct input-to-output mapping.

The runtime system prompt already carries the invariant classifier instructions, so adapter records should not repeat long prose such as "classify the final message" or "return JSON only" in every user message. Repeating those instructions burns training tokens without adding much example diversity.

The user message should still preserve the Open Classify input shape:

```text
Conversation window:
Message 1 (target):
role: user
text:
thanks, that's all

Attachments:
none
```

This keeps examples compact while still teaching the model that classification targets the final conversation-window message and that attachments are represented as metadata.

Single-message windows are preferred for simple examples. Use multi-message windows only when the label depends on context, such as referential context sufficiency, memory hints, or digest resolution. Use `Attachments: none` unless the classifier label depends on attachment metadata.

The assistant message must contain only the classifier's JSON result. Do not include explanations, Markdown, comments, or combined outputs from other classifiers.

Before generating a batch, read the matching guide and decide the target label mix. Prefer examples that stress the classifier's boundaries over easy duplicates.

Runtime model selection is configured separately in `adapter-models.json` at the project root. Ollama chat requests select model names; they do not attach these JSONL files directly per request.
