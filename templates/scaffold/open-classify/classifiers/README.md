# classifiers/

Drop a folder here per classifier. Each folder needs two files:

- `manifest.json` — declares the output shape and a fallback
- `prompt.md` — the classification instructions

The folder name must match the manifest's `name` field. The runtime picks
up every classifier here on the next start.

To customize one of the four stock classifiers (`tools`,
`memory_retrieval_queries`, `conversation_digest`, `context_shift`):

```sh
npx open-classify eject tools
```

That copies the stock files into `classifiers/tools/`. You own them from
then on — `npm update open-classify` won't touch them.

See the [author guide](https://github.com/taylorbayouth/open-classify/blob/main/docs/adding-a-classifier.md)
for the full manifest reference.
