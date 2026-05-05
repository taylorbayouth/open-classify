# Adapter Discovery

Open Classify checks this folder before each Ollama runner is created.

Use one folder per classifier. Each folder can contain JSONL training buckets and, later, an optional `model.txt` file:

```txt
adapters/
  preflight/
    creative_generation.jsonl
    model.txt
  routing/
    creative_generation.jsonl
    model.txt
```

The `.jsonl` files are scenario buckets. They currently contain one sample row each so the schema and taxonomy are explicit; future training sets can add many rows to the same files.

Each adapter output must match its classifier's schema. Do not train the seven adapters on a combined classifier object.

When an adapter model exists in Ollama, add `model.txt` to that classifier folder. It should contain the Ollama model name for that classifier's adapter. The first non-empty, non-comment line is used.

```txt
# optional comment
open-classify-preflight:v0.1.0
```

Missing classifier folders or `model.txt` files are intentional and safe. The runner falls back to `gemma4:e4b-it-q4_K_M` for those classifiers.

Ollama chat requests select model names, so create/register the adapter as an Ollama model before adding the `model.txt` entry.
