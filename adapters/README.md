# Adapter Discovery

Open Classify checks this folder before each Ollama runner is created.

Use one folder per classifier:

```txt
adapters/
  preflight/model.txt
  downstream_route/model.txt
  context_sufficiency/model.txt
  memory_retrieval_queries/model.txt
  tool_family_need/model.txt
  message_and_attachment_digest/model.txt
  security_posture/model.txt
```

Each `model.txt` should contain the Ollama model name for that classifier's adapter. The first non-empty, non-comment line is used.

```txt
# optional comment
open-classify-preflight:v0.1.0
```

Missing classifier folders or `model.txt` files are intentional and safe. The runner falls back to `gemma4:e4b-it-q4_K_M` for those classifiers.

Ollama chat requests select model names, so create/register the adapter as an Ollama model before adding the `model.txt` entry.
