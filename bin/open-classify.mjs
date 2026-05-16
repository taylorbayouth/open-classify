#!/usr/bin/env node
// open-classify CLI. Subcommands: init, doctor, try.
//
// init: scaffold the standard project layout for a consumer.
// doctor: verify the install, config, Ollama, and classifiers are all working.
// try: run the pipeline against a single message and print the result.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const TEMPLATES_DIR = join(PACKAGE_ROOT, "templates");

const TEMPLATE_NAMES = ["conversation_digest", "context_shift", "memory_retrieval_queries", "tools"];

const TEMPLATE_DESCRIPTIONS = {
  conversation_digest: "rolling summary of recent turns",
  context_shift: "detects topic changes",
  memory_retrieval_queries: "generates queries for a memory store",
  tools: "tool-call routing",
};

const CLASSIFIERS_README = `# classifiers/

Drop a folder here per classifier. Each folder needs:

- \`manifest.json\` — see [open-classify docs](https://github.com/taylorbayouth/open-classify/blob/main/docs/adding-a-classifier.md)
- \`prompt.md\` — the classifier-specific instructions

## Quickstart

\`\`\`js
import { createClassifier } from "open-classify";

const { classify } = createClassifier({
  extraClassifierDirs: ["./classifiers"],
});
\`\`\`

Place this in your server entry point. Call \`classify(input)\` for each user message.
\`extraClassifierDirs\` is resolved relative to the current working directory.

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "init") {
    const flags = parseInitFlags(args.slice(1));
    await runInit({ cwd: process.cwd(), ...flags });
    return;
  }

  if (subcommand === "doctor") {
    await runDoctor({ cwd: process.cwd() });
    return;
  }

  if (subcommand === "try") {
    const message = args.slice(1).join(" ");
    await runTry({ cwd: process.cwd(), message });
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseInitFlags(args) {
  const flags = {
    yes: false,
    minimal: false,
    dryRun: false,
    force: false,
    noInstall: false,
    packageManager: null,
    classifierDir: "classifiers",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--minimal") flags.minimal = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--no-install") flags.noInstall = true;
    else if (arg === "--package-manager" && args[i + 1]) flags.packageManager = args[++i];
    else if (arg.startsWith("--package-manager=")) flags.packageManager = arg.split("=")[1];
    else if (arg === "--classifier-dir" && args[i + 1]) flags.classifierDir = args[++i];
    else if (arg.startsWith("--classifier-dir=")) flags.classifierDir = arg.split("=")[1];
  }

  return flags;
}

function printHelp() {
  process.stdout.write(`open-classify — runtime CLI

Commands:
  init [options]    Scaffold open-classify.config.json and classifiers/ in the
                    current directory. Re-run safe: existing files are skipped.

  doctor            Check that the install, config, Ollama, and classifiers are
                    all working. Exits non-zero on failure.

  try <message>     Run the pipeline against a single message and print the
                    result. Useful for verifying your setup without touching
                    application code.

Options for init:
  --minimal              Write only open-classify.config.json; skip classifiers/
  --dry-run              Preview what would be created; don't write anything
  --force                Overwrite existing files without prompting
  --no-install           Skip the "add to package.json" prompt
  --package-manager <m>  npm | pnpm | yarn | bun  (default: auto-detect)
  --classifier-dir <p>   Directory for classifiers  (default: ./classifiers)
  --yes, -y              Accept all prompts (CI mode)

`);
}

function detectPackageManager(cwd) {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function isOpenClassifyDep(pkg) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
    (f) => pkg[f]?.["open-classify"],
  );
}

function getCliVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit({ cwd, yes, minimal, dryRun, force, noInstall, packageManager, classifierDir }) {
  // 1. Preflight: require a host project.
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    process.stderr.write(
      `✖  No package.json found in ${cwd}.\n` +
      `   open-classify scaffolds code that imports the library, so it needs a\n` +
      `   Node project to live in.\n\n` +
      `   Create one first:  npm init -y\n`,
    );
    process.exit(1);
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    process.stderr.write(`✖  Could not parse package.json at ${pkgPath}\n`);
    process.exit(1);
  }

  // 2. Offer to install if not yet a dependency (skip in --yes / --no-install mode).
  let installedNow = false;
  if (!isOpenClassifyDep(pkg) && !noInstall && !yes) {
    process.stdout.write(`ℹ  open-classify is not yet a dependency of this project.\n\n`);
    const doInstall = await confirm("? Add open-classify to package.json and install it now? (Y/n) ", true);
    if (doInstall) {
      const pm = packageManager || detectPackageManager(cwd);
      const installCmd = pm === "npm" ? ["install", "open-classify"] : ["add", "open-classify"];
      process.stdout.write(`\n  Running: ${pm} ${installCmd.join(" ")}\n\n`);
      const result = spawnSync(pm, installCmd, { cwd, stdio: "inherit" });
      if (result.status !== 0) {
        process.stderr.write(`\n✖  Install failed. Run manually: ${pm} ${installCmd.join(" ")}\n`);
        process.exit(1);
      }
      installedNow = true;
      process.stdout.write("\n");
    } else {
      process.stdout.write(
        `  Skipped. You'll need to run \`npm install open-classify\` before importing.\n\n`,
      );
    }
  }

  // 3. Plan.
  const resolvedClassifierDir = resolve(cwd, classifierDir);
  const wrote = { config: false, readme: false, templateCount: 0 };
  let plan = planInit(cwd, { minimal, classifierDir: resolvedClassifierDir, force, wrote });

  // Nothing to do.
  if (plan.toCreate.length === 0) {
    process.stdout.write("Nothing to do — your project already has all the scaffolded files.\n");
    if (plan.toSkip.length > 0) {
      process.stdout.write("\nAlready in place:\n");
      for (const p of plan.toSkip) process.stdout.write(`  ${p}\n`);
    }
    return;
  }

  // 4. Preview.
  process.stdout.write(`\nThe following will be created in ${cwd}:\n\n`);
  for (const item of plan.preview) {
    if (item.isGroupHeader) {
      process.stdout.write(`  ${item.label}\n`);
    } else if (item.indent) {
      process.stdout.write(`    ${item.label.padEnd(32)}  ${item.description}\n`);
    } else {
      process.stdout.write(`  ${item.label.padEnd(34)}  ${item.description}\n`);
    }
  }

  if (plan.toSkip.length > 0) {
    process.stdout.write(`\n⚠  These files already exist and will be skipped:\n`);
    for (const p of plan.toSkip) process.stdout.write(`     ${p}\n`);
  }

  // 5. Stop here on --dry-run.
  if (dryRun) {
    process.stdout.write("\n(dry run — nothing written)\n");
    return;
  }

  // 6. Conflict handling: interactive only (not --yes, not --force).
  if (plan.toSkip.length > 0 && !yes && !force) {
    const choice = await promptConflict();
    if (choice === "diff") {
      showDiffs(plan.toSkip, cwd, resolvedClassifierDir);
      const choice2 = await promptConflict();
      if (choice2 === "y") {
        plan = planInit(cwd, { minimal, classifierDir: resolvedClassifierDir, force: true, wrote });
      }
    } else if (choice === "y") {
      plan = planInit(cwd, { minimal, classifierDir: resolvedClassifierDir, force: true, wrote });
    }
  }

  // 7. Confirm (skip in --yes mode).
  if (!yes) {
    const proceed = await confirm("\n? Continue? (Y/n) ", true);
    if (!proceed) {
      process.stdout.write("Aborted.\n");
      process.exit(1);
    }
  }

  // 8. Execute.
  process.stdout.write("\n");
  for (const action of plan.actions) action();

  // 9. Summary + next steps.
  process.stdout.write("\n");
  if (installedNow) {
    const v = getCliVersion();
    process.stdout.write(`✓ open-classify installed${v ? ` (v${v})` : ""}\n`);
  }
  if (wrote.config) process.stdout.write("✓ wrote open-classify.config.json\n");
  if (wrote.readme || wrote.templateCount > 0) {
    const classifierDirRel = relative(cwd, resolvedClassifierDir);
    if (wrote.templateCount > 0) {
      process.stdout.write(`✓ scaffolded ${wrote.templateCount} classifier(s) in ./${classifierDirRel}/\n`);
    } else {
      process.stdout.write(`✓ wrote ./${classifierDirRel}/README.md\n`);
    }
  }

  const classifierDirRel = relative(cwd, resolvedClassifierDir);
  process.stdout.write(`
Next steps:

  1. Pull the default model:
       ollama pull ${DEFAULT_CONFIG.runner.defaultModel}

  2. Wire it into your server (example for a Node entrypoint):
       see  ./${classifierDirRel}/README.md  →  "Quickstart"

  3. Verify the install:
       npx open-classify doctor

  4. Run a one-shot classification against your config:
       npx open-classify try "hello world"

Docs:  https://github.com/taylorbayouth/open-classify#readme
`);
}

function planInit(cwd, { minimal = false, classifierDir, force = false, wrote }) {
  const toCreate = [];
  const toSkip = [];
  const actions = [];
  const preview = [];

  // Config file.
  const configPath = join(cwd, "open-classify.config.json");
  const configRel = relative(cwd, configPath);
  if (existsSync(configPath) && !force) {
    toSkip.push(configRel);
  } else {
    toCreate.push(configRel);
    preview.push({ label: configRel, description: `(default Ollama setup, ${DEFAULT_CONFIG.runner.defaultModel})` });
    actions.push(() => {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
      process.stdout.write(`  wrote ${configRel}\n`);
      wrote.config = true;
    });
  }

  if (!minimal) {
    const classifierPreviewItems = [];

    // Ensure the directory exists (prerequisite for all classifier actions).
    if (!existsSync(classifierDir)) {
      toCreate.push(`${relative(cwd, classifierDir)}/`);
      actions.push(() => {
        mkdirSync(classifierDir, { recursive: true });
      });
    }

    // README.md.
    const readmePath = join(classifierDir, "README.md");
    const readmeRel = relative(cwd, readmePath);
    if (existsSync(readmePath) && !force) {
      toSkip.push(readmeRel);
    } else {
      toCreate.push(readmeRel);
      classifierPreviewItems.push({ label: "README.md", indent: true, description: "how to author your own classifier" });
      actions.push(() => {
        mkdirSync(classifierDir, { recursive: true });
        writeFileSync(readmePath, CLASSIFIERS_README);
        process.stdout.write(`  wrote ${readmeRel}\n`);
        wrote.readme = true;
      });
    }

    // Template classifier directories.
    for (const name of TEMPLATE_NAMES) {
      const inactivePath = join(classifierDir, `_${name}`);
      const activePath = join(classifierDir, name);
      const inactiveRel = relative(cwd, inactivePath);
      const activeRel = relative(cwd, activePath);

      // Never overwrite an activated (user-renamed) template.
      if (existsSync(activePath)) {
        toSkip.push(`${activeRel}/`);
        continue;
      }

      if (existsSync(inactivePath) && !force) {
        toSkip.push(`${inactiveRel}/`);
        continue;
      }

      toCreate.push(`${inactiveRel}/`);
      classifierPreviewItems.push({
        label: `_${name}/`,
        indent: true,
        description: TEMPLATE_DESCRIPTIONS[name],
      });
      actions.push(() => {
        mkdirSync(classifierDir, { recursive: true });
        if (force && existsSync(inactivePath)) {
          rmSync(inactivePath, { recursive: true, force: true });
        }
        cpSync(join(TEMPLATES_DIR, name), inactivePath, { recursive: true });
        process.stdout.write(`  wrote ${inactiveRel}/\n`);
        wrote.templateCount++;
      });
    }

    if (classifierPreviewItems.length > 0) {
      preview.push({ label: `${relative(cwd, classifierDir)}/`, isGroupHeader: true });
      preview.push(...classifierPreviewItems);
    }
  }

  return { toCreate, toSkip, actions, preview };
}

function showDiffs(conflicts, cwd, classifierDir) {
  for (const p of conflicts) {
    const isDir = p.endsWith("/");
    const relPath = isDir ? p.slice(0, -1) : p;
    const fullPath = join(cwd, relPath);

    process.stdout.write(`\n--- ${p} ---\n`);

    if (!isDir) {
      process.stdout.write("\n  current:\n");
      try {
        const lines = readFileSync(fullPath, "utf8").split("\n");
        for (const line of lines) process.stdout.write(`    ${line}\n`);
      } catch {
        process.stdout.write("    (could not read)\n");
      }
      process.stdout.write("\n  would become:\n");
      for (const line of JSON.stringify(DEFAULT_CONFIG, null, 2).split("\n")) {
        process.stdout.write(`    ${line}\n`);
      }
    } else {
      process.stdout.write("\n  current files:\n");
      try {
        for (const f of readdirSync(fullPath)) process.stdout.write(`    ${f}\n`);
      } catch {
        process.stdout.write("    (could not read)\n");
      }
      const templateName = basename(relPath).replace(/^_/, "");
      const templatePath = join(TEMPLATES_DIR, templateName);
      if (existsSync(templatePath)) {
        process.stdout.write("\n  template files:\n");
        for (const f of readdirSync(templatePath)) process.stdout.write(`    ${f}\n`);
      }
    }
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function runDoctor({ cwd }) {
  let allGood = true;

  // 1. package.json + open-classify dep.
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    process.stdout.write("✖  No package.json — not a Node project\n");
    allGood = false;
  } else {
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { pkg = {}; }
    if (isOpenClassifyDep(pkg)) {
      process.stdout.write("✓  open-classify found in package.json\n");
    } else {
      process.stdout.write("⚠  open-classify not listed as a dependency\n");
      allGood = false;
    }
  }

  // 2. Config parses.
  const configPath = join(cwd, "open-classify.config.json");
  if (!existsSync(configPath)) {
    process.stdout.write("✖  No open-classify.config.json — run: npx open-classify init\n");
    allGood = false;
  } else {
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
      process.stdout.write("✓  open-classify.config.json parses OK\n");

      // 3. Ollama reachable.
      const host = config.runner?.host || DEFAULT_CONFIG.runner.host;
      try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          process.stdout.write(`✓  Ollama reachable at ${host}\n`);

          // 4. Default model pulled.
          const data = await res.json();
          const model = config.runner?.defaultModel || DEFAULT_CONFIG.runner.defaultModel;
          const pulled = data.models?.some((m) => m.name === model || m.model === model);
          if (pulled) {
            process.stdout.write(`✓  Model ${model} is available\n`);
          } else {
            process.stdout.write(`✖  Model ${model} not found — run: ollama pull ${model}\n`);
            allGood = false;
          }
        } else {
          process.stdout.write(`✖  Ollama responded ${res.status} at ${host}\n`);
          allGood = false;
        }
      } catch {
        process.stdout.write(`✖  Ollama not reachable at ${host} — is it running?\n`);
        allGood = false;
      }
    } catch {
      process.stdout.write("✖  open-classify.config.json is not valid JSON\n");
      allGood = false;
    }
  }

  // 5. Classifiers directory.
  const classifiersDir = join(cwd, "classifiers");
  if (existsSync(classifiersDir)) {
    let active = 0;
    let bad = 0;
    try {
      for (const entry of readdirSync(classifiersDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
        const dir = join(classifiersDir, entry.name);
        const ok =
          existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "prompt.md"));
        if (ok) active++;
        else {
          process.stdout.write(`✖  classifiers/${entry.name}/ is missing manifest.json or prompt.md\n`);
          bad++;
          allGood = false;
        }
      }
    } catch { /* skip */ }
    if (bad === 0) {
      process.stdout.write(
        active > 0
          ? `✓  ${active} active classifier(s) in classifiers/\n`
          : "ℹ  No active classifiers in classifiers/ (activate a template with: mv _name name)\n",
      );
    }
  } else {
    process.stdout.write("ℹ  No classifiers/ directory — run: npx open-classify init\n");
  }

  if (!allGood) process.exit(1);
}

// ---------------------------------------------------------------------------
// try
// ---------------------------------------------------------------------------

async function runTry({ cwd, message }) {
  if (!message) {
    process.stderr.write("Usage: open-classify try <message>\n");
    process.exit(1);
  }

  const configPath = join(cwd, "open-classify.config.json");
  if (!existsSync(configPath)) {
    process.stderr.write("✖  No open-classify.config.json — run: npx open-classify init\n");
    process.exit(1);
  }

  // Try loading from the consumer's node_modules first, then fall back to the
  // package root (useful when running from the development checkout).
  let createClassifier;
  const candidates = [
    join(cwd, "node_modules", "open-classify", "dist", "src", "index.js"),
    join(PACKAGE_ROOT, "dist", "src", "index.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const mod = await import(candidate);
      createClassifier = mod.createClassifier;
      break;
    } catch { /* try next */ }
  }

  if (!createClassifier) {
    process.stderr.write(
      "✖  Could not load the open-classify runtime.\n" +
      "   Is the package installed? Run: npm install open-classify\n",
    );
    process.exit(1);
  }

  const classifiersDir = join(cwd, "classifiers");
  let classifier;
  try {
    classifier = createClassifier({
      configPath,
      extraClassifierDirs: existsSync(classifiersDir) ? [classifiersDir] : [],
      skipResourceCheck: false,
    });
  } catch (err) {
    process.stderr.write(`✖  Failed to initialise classifier: ${err.message}\n`);
    process.exit(1);
  }

  try {
    const result = await classifier.classify({
      messages: [{ role: "user", text: message }],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`✖  Classification failed: ${err.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function confirm(prompt, defaultYes = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const v = (answer || "").trim().toLowerCase();
      resolve(defaultYes ? (v === "" || v === "y" || v === "yes") : (v === "y" || v === "yes"));
    });
  });
}

function promptConflict() {
  return new Promise((resolve) => {
    process.stdout.write("\n? Overwrite them?\n   y      overwrite all\n   N      keep existing (default)\n   diff   show what would change\n\n");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  Choice (y/N/diff): ", (answer) => {
      rl.close();
      const v = (answer || "").trim().toLowerCase();
      if (v === "y" || v === "yes") resolve("y");
      else if (v === "diff") resolve("diff");
      else resolve("N");
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
