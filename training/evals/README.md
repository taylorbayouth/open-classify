# Evals

Hand-curated eval sets, one JSONL file per classifier. **These ARE committed to git** — they're the shared baseline that lets everyone measure whether new training data improved or regressed Gemma's behavior.

```txt
evals/preflight.jsonl
evals/routing.jsonl
evals/conversation_history.jsonl
evals/memory_retrieval_queries.jsonl
evals/tools.jsonl
evals/model_specialization.jsonl
evals/security.jsonl
```

## Shape

Each row is the same JSONL chat-format record used in `training-data/`: a system message, a user message containing the conversation window, and the expected assistant JSON output. The runner compares the trained adapter's output against the expected JSON.

## Sizing

20–50 rows per classifier. Cover boundary cases first — easy rows do not catch regressions. Vary conversation length so eval inputs match production reality (single-message rows up through ~10-message windows). Some classifiers (e.g., `tools`) restrict training data to single-message rows for token efficiency, but evals can still include longer windows to verify the classifier focuses on the latest message under realistic conditions.

## Anti-leakage

Eval rows must never appear in `training-data/` even though that folder is gitignored. Treat eval rows as the held-out test set: paraphrase, rephrase, or invent fresh wording rather than copying from a generated training batch. Leakage makes eval scores meaningless.
