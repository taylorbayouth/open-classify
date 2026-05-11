# Adapters

Trained adapter weights land here after fine-tuning, one subdirectory per classifier:

```txt
adapters/preflight/
adapters/routing/
adapters/conversation_history/
adapters/memory_retrieval_queries/
adapters/tools/
adapters/model_specialization/
adapters/security/
```

**Everything in this folder is gitignored except `*.md`.** Adapter weights are large (LoRA checkpoints are typically 50–500 MB each) and user-specific, so they don't belong in the repo — but the folder structure stays visible via README files so the convention is discoverable.

## Workflow

After running fine-tuning against the corresponding `training-data/<classifier>.jsonl`:

1. Drop the resulting adapter (GGUF / LoRA weights) into `adapters/<classifier>/`.
2. Import into Ollama via a Modelfile that references the adapter, e.g.:
   ```
   FROM gemma3:4b
   ADAPTER ./adapter.gguf
   ```
3. `ollama create open-classify-<classifier> -f Modelfile`
4. Copy `adapter-models.example.json` to `adapter-models.json` if needed, then point this classifier at the new local model name.
5. Run `training/evals/<classifier>.jsonl` through the pipeline to confirm quality moved in the right direction.
