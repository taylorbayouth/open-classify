# open-classify/

Everything Open Classify reads at runtime lives in this folder:

- `config.json` — runtime configuration (Ollama host, model, classifier dirs)
- `downstream-models.json` — catalog of models the aggregator can route to
- `classifiers/` — your own classifiers, plus any stock classifiers you've
  ejected for customization

To remove Open Classify entirely:

```sh
rm -rf open-classify/
npm uninstall open-classify
```

## config.json reference

All fields are optional except `runner.provider` (defaults to `"ollama"` when omitted).

```jsonc
{
  "runner": {
    // Only "ollama" is supported.
    "provider": "ollama",

    // Ollama base URL. Defaults to http://127.0.0.1:11434.
    "host": "http://127.0.0.1:11434",

    // Model used by all classifiers unless overridden by runner.models or
    // a classifier's own backend.ollama.base_model field.
    "defaultModel": "gemma4:e4b-it-q4_K_M",

    // Ollama inference parameters applied to every classifier call.
    // All sub-fields are optional.
    "options": {
      "temperature": 0.1,   // Float. Lower = more deterministic. Default: Ollama model default.
      "top_p": 0.95,        // Float. Nucleus sampling cutoff. Default: Ollama model default.
      "num_ctx": 8192,      // Integer. Context window size in tokens. Default: Ollama model default.
      "seed": 42            // Integer. Fixed seed for reproducible outputs. Default: random.
    },

    // Per-classifier model overrides. Each key must match a loaded classifier
    // name exactly (typos are caught at startup). Useful for routing a
    // latency-sensitive classifier to a smaller model while keeping a
    // stronger default for everything else.
    "models": {
      "prompt_injection": "gemma4:e4b-it-q4_K_M"
    }
  },

  // Path to the downstream model catalog, relative to this file.
  // Defaults to "downstream-models.json".
  "catalog": "downstream-models.json",

  "classifiers": {
    // Directories to scan for user classifiers, relative to this file.
    // Defaults to ["classifiers"]. Add extra dirs if you keep classifiers
    // in multiple locations (e.g. a shared monorepo package).
    "dirs": ["classifiers"],

    // Optional stock classifiers to enable. Off by default.
    // Available: "tools", "memory_retrieval_queries", "conversation_digest", "context_shift"
    // To customize one, run: npx open-classify eject <name>
    "stock": []
  }
}
```

Note: the scaffold `config.json` uses standard JSON (no comments). The `jsonc` format above is for illustration only.

## Stock classifiers

Open Classify ships four optional stock classifiers that live inside the `open-classify` package. Enable any by listing their names in `classifiers.stock`:

```json
{
  "classifiers": {
    "stock": ["tools", "memory_retrieval_queries", "conversation_digest", "context_shift"]
  }
}
```

The package-owned prompt is used, and `npm update open-classify` keeps it current. When you need to take a stock classifier over and edit it:

```sh
npx open-classify eject tools
```

That copies the stock files into `classifiers/tools/`. From that point on, the runtime uses your local copy and `npm update` leaves it alone. A local classifier always wins on name, so eject works whether or not `tools` is listed in `classifiers.stock`. Delete the folder to revert.

See `classifiers/README.md` for the full manifest field reference.
