#!/usr/bin/env node
// open-classify CLI. Currently exposes a single subcommand: `init`.
//
// `init` scaffolds the standard project layout for a consumer:
//   - open-classify.config.json (minimal)
//   - classifiers/
//     - README.md
//     - _conversation_digest/  (templates, prefix means inactive)
//     - _context_shift/
//     - _memory_retrieval_queries/
//     - _tools/
//
// Re-run safe: existing files are skipped, never overwritten. Use
// `--yes` to skip the confirmation prompt (for scripted setup).

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const TEMPLATES_DIR = join(PACKAGE_ROOT, "templates");

const TEMPLATE_NAMES = ["conversation_digest", "context_shift", "memory_retrieval_queries", "tools"];

const CLASSIFIERS_README = `# classifiers/

Drop a folder here per classifier. Each folder needs:

- \`manifest.json\` — see [open-classify docs](https://github.com/taylorbayouth/open-classify/blob/main/docs/adding-a-classifier.md)
- \`prompt.md\` — the classifier-specific instructions

## Activating templates

The four \`_<name>/\` directories below are templates copied from the package — they ship inactive (the loader skips any folder starting with \`_\`). Activate one by dropping the underscore:

\`\`\`sh
mv _tools tools
\`\`\`

You probably also want to edit its \`manifest.json\` first to fit your app (e.g. trim the \`allowed_tools\` list).

## Deactivating without deleting

Same trick in reverse — rename \`my_classifier\` → \`_my_classifier\` to take it out of the active set without losing your work.
`;

const DEFAULT_CONFIG = {
  runner: {
    provider: "ollama",
    host: "http://127.0.0.1:11434",
    defaultModel: "gemma4:e4b-it-q4_K_M",
  },
  catalog: "downstream-models.json",
};

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "init") {
    const yes = args.includes("--yes") || args.includes("-y");
    await runInit({ cwd: process.cwd(), yes });
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  process.stdout.write(`open-classify — runtime CLI

Commands:
  init [--yes]    Scaffold open-classify.config.json and classifiers/ in the
                  current directory. Re-run safe: existing files are skipped.

`);
}

async function runInit({ cwd, yes }) {
  const plan = planInit(cwd);

  if (plan.toCreate.length === 0) {
    console.log("Nothing to do — your project already has all the scaffolded files.");
    if (plan.toSkip.length > 0) {
      console.log("\nAlready in place:");
      for (const p of plan.toSkip) console.log(`  ${p}`);
    }
    return;
  }

  console.log("This will create:");
  for (const p of plan.toCreate) console.log(`  ${p}`);
  if (plan.toSkip.length > 0) {
    console.log("\nAlready exists (will skip):");
    for (const p of plan.toSkip) console.log(`  ${p}`);
  }

  if (!yes) {
    const proceed = await confirm("\nContinue? [Y/n] ");
    if (!proceed) {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  for (const action of plan.actions) {
    action();
  }

  console.log("\nDone. Wire it into your code:\n");
  console.log("  import { createClassifier } from \"open-classify\";");
  console.log("  const { classify } = createClassifier({");
  console.log("    extraClassifierDirs: [\"./classifiers\"],");
  console.log("  });");
}

function planInit(cwd) {
  const toCreate = [];
  const toSkip = [];
  const actions = [];

  const configPath = join(cwd, "open-classify.config.json");
  if (existsSync(configPath)) {
    toSkip.push(relative(cwd, configPath));
  } else {
    toCreate.push(relative(cwd, configPath));
    actions.push(() => {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      console.log(`wrote ${relative(cwd, configPath)}`);
    });
  }

  const classifiersDir = join(cwd, "classifiers");
  if (!existsSync(classifiersDir)) {
    toCreate.push(relative(cwd, classifiersDir) + "/");
    actions.push(() => {
      mkdirSync(classifiersDir, { recursive: true });
      console.log(`created ${relative(cwd, classifiersDir)}/`);
    });
  }

  const readmePath = join(classifiersDir, "README.md");
  if (existsSync(readmePath)) {
    toSkip.push(relative(cwd, readmePath));
  } else {
    toCreate.push(relative(cwd, readmePath));
    actions.push(() => {
      // The classifiers dir may not yet exist when we generated the plan,
      // but it will by the time this action runs.
      mkdirSync(classifiersDir, { recursive: true });
      writeFileSync(readmePath, CLASSIFIERS_README);
      console.log(`wrote ${relative(cwd, readmePath)}`);
    });
  }

  for (const name of TEMPLATE_NAMES) {
    const inactivePath = join(classifiersDir, `_${name}`);
    const activePath = join(classifiersDir, name);

    if (existsSync(inactivePath) || existsSync(activePath)) {
      // Either already scaffolded (inactive) or already activated by the
      // consumer. Either way, leave it alone.
      toSkip.push(relative(cwd, existsSync(activePath) ? activePath : inactivePath) + "/");
      continue;
    }

    toCreate.push(relative(cwd, inactivePath) + "/");
    actions.push(() => {
      mkdirSync(classifiersDir, { recursive: true });
      cpSync(join(TEMPLATES_DIR, name), inactivePath, { recursive: true });
      console.log(`wrote ${relative(cwd, inactivePath)}/`);
    });
  }

  return { toCreate, toSkip, actions };
}

function confirm(prompt) {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const normalized = (answer || "").trim().toLowerCase();
      resolveAnswer(normalized === "" || normalized === "y" || normalized === "yes");
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
