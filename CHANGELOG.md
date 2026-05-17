# Changelog

## 1.0.0

A focused rewrite of the consumer-facing surface. The runtime is unchanged; what's new is how a consumer installs, configures, and customizes Open Classify.

### Scaffold layout

The scaffold is now a single directory at the project root:

```
your-project/
└── open-classify/
    ├── config.json
    ├── downstream-models.json
    ├── README.md
    └── classifiers/
        └── README.md
```

Previously, `init` wrote three things at the project root (`open-classify.config.json`, `downstream-models.json`, `classifiers/`) plus four `_<name>/` template folders inside `classifiers/`. The 1.0 scaffold keeps everything together in one folder, leaves `classifiers/` empty by default, and uses the new `eject` command for stock-classifier customization.

### CLI

Subcommands:

- `init` — copy `open-classify/` into the current project. Re-run safe.
- `eject <name>` — copy a stock classifier (`tools`, `memory_retrieval_queries`, `conversation_digest`, `context_shift`) into `open-classify/classifiers/<name>/` so you can edit it.
- `doctor` — verify install, config, Ollama, classifiers.
- `try <message>` — one-shot smoke test.

Flags trimmed to `--yes`, `--force`, `--dry-run` across the board.

Removed:

- `uninstall` subcommand. `rm -rf open-classify/ && npm uninstall open-classify` is the documented path. Bundling it into a CLI created the npx "needs to install" prompt — the cure was worse than the disease.
- `init --minimal`, `init --no-install`, `init --package-manager`, `init --classifier-dir`. None of these earned their slot in the help text.
- `init`'s auto-install. Install the package first (`npm install open-classify`), then run `init`. Predictable; matches every other tool in the ecosystem.

### Config schema

- Default path: `open-classify/config.json` (was `open-classify.config.json` at project root).
- `classifiers.stock` is now a `string[]` of names to enable (was a `Record<string, boolean>` map).
- All paths in the config (`catalog`, `classifiers.dirs`) resolve relative to the config file's directory — so the scaffold works regardless of where your server starts from.

### Stock classifier customization

The `_<name>/` template-rename pattern is gone. Customizing a stock classifier is now an explicit `eject`:

```sh
npx open-classify eject tools
```

Copies the stock files into `open-classify/classifiers/tools/`. The runtime transparently prefers your local copy over the package version — a user classifier with the same name as a stock classifier always wins. To revert, delete the folder.

### Package contents

Templates split into:

- `templates/scaffold/open-classify/` — copied wholesale by `init`
- `templates/stock/<name>/` — copied one at a time by `eject <name>`

Every scaffolded file is a real file in the package now, not an inlined JS string constant. The scaffolded `config.json`, README, and stock classifiers are all maintainable as their native file types.

### Removed from the package

- Root `downstream-models.json` (moved into `templates/scaffold/open-classify/`)
- Root `open-classify.config.example.json` (the scaffold IS the example)

### Migration from 0.9.x

If you were using a 0.9.x install:

```sh
# Move existing files into the new layout
mkdir -p open-classify/classifiers
mv open-classify.config.json open-classify/config.json
mv downstream-models.json open-classify/downstream-models.json
mv classifiers/* open-classify/classifiers/ 2>/dev/null || true
rmdir classifiers 2>/dev/null || true

# Edit open-classify/config.json: change classifiers.stock from { "tools": true, ... }
# to ["tools", ...] — only list the names that were set to true.

# Update to 1.0
npm install open-classify@latest
```

If you had renamed any `_<name>/` template folders to activate them (e.g. `_tools/` → `tools/`), they'll still work in the new layout — local classifiers always win over stock by name.
