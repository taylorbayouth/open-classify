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

## Stock classifiers

Open Classify ships four optional stock classifiers (`tools`,
`memory_retrieval_queries`, `conversation_digest`, `context_shift`) that
live inside the `open-classify` package. Enable one by listing its name
in `config.json`:

```json
{
  "classifiers": {
    "dirs": ["classifiers"],
    "stock": ["tools"]
  }
}
```

The package-owned prompt is used, and `npm update open-classify` keeps it
current. When you need to take a stock classifier over and edit it:

```sh
npx open-classify eject tools
```

That copies the stock files into `classifiers/tools/`. From that point on,
the runtime uses your local copy and `npm update` leaves it alone.

See the [author guide](https://github.com/taylorbayouth/open-classify/blob/main/docs/adding-a-classifier.md)
for writing your own classifier from scratch.
