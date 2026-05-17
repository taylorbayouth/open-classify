#!/usr/bin/env node
// open-classify CLI.
//
//   init               Copy the scaffold (open-classify/) into the current directory.
//   eject <name>       Copy a stock classifier into open-classify/classifiers/<name>/.
//   doctor             Verify install, config, Ollama, and classifiers.
//   try <message>      Run the pipeline against a single message.
//
// Removal is intentionally not a subcommand — `rm -rf open-classify/` and
// `npm uninstall open-classify` cover it, and bundling them creates more
// confusion than convenience (notably the npx "needs to install" prompt
// when the package isn't a dep yet).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const SCAFFOLD_DIR = join(PACKAGE_ROOT, "templates", "scaffold", "open-classify");
const STOCK_DIR = join(PACKAGE_ROOT, "templates", "stock");
const PROJECT_DIRNAME = "open-classify";
const STOCK_NAMES = ["tools", "memory_retrieval_queries", "conversation_digest", "context_shift"];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printHelp();
    process.exit(subcommand ? 0 : 1);
  }

  switch (subcommand) {
    case "init":
      await runInit({ cwd: process.cwd(), ...parseFlags(rest) });
      return;
    case "eject":
      await runEject({ cwd: process.cwd(), name: rest[0], ...parseFlags(rest.slice(1)) });
      return;
    case "doctor":
      await runDoctor({ cwd: process.cwd() });
      return;
    case "try": {
      const message = rest.join(" ");
      await runTry({ cwd: process.cwd(), message });
      return;
    }
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
      printHelp();
      process.exit(1);
  }
}

function parseFlags(args) {
  const flags = { yes: false, force: false, dryRun: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--dry-run") flags.dryRun = true;
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`open-classify — runtime CLI

Commands:
  init                Scaffold ./open-classify/ in the current directory.
                      Re-run safe: existing files are skipped unless --force.

  eject <name>        Copy a stock classifier into ./open-classify/classifiers/<name>/
                      so you can edit it. Stock classifiers:
                      ${STOCK_NAMES.join(", ")}

  doctor              Verify install, config, Ollama, and classifiers.
                      Exits non-zero on failure.

  try <message>       Run the pipeline against a single message and print
                      the result.

Options:
  --yes, -y           Accept all prompts (CI mode)
  --force             Overwrite existing files
  --dry-run           Preview what would change; don't write anything

Setup:
  npm install open-classify
  npx open-classify init

Removal:
  rm -rf open-classify/
  npm uninstall open-classify

Docs:  https://github.com/taylorbayouth/open-classify#readme
`);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit({ cwd, yes, force, dryRun }) {
  requireHostProject(cwd);
  warnIfPackageMissing(cwd);

  const destRoot = join(cwd, PROJECT_DIRNAME);
  const plan = planScaffoldCopy(SCAFFOLD_DIR, destRoot, cwd, force);

  if (plan.actions.length === 0) {
    process.stdout.write(`Nothing to do — ./${PROJECT_DIRNAME}/ already has every scaffold file.\n`);
    if (plan.skipped.length > 0) {
      process.stdout.write("\nAlready present (use --force to overwrite):\n");
      for (const p of plan.skipped) process.stdout.write(`  ${p}\n`);
    }
    return;
  }

  process.stdout.write(`\nThe following will be created in ${cwd}:\n\n`);
  for (const item of plan.preview) process.stdout.write(`  ${item}\n`);

  if (plan.skipped.length > 0) {
    process.stdout.write(`\nAlready present (use --force to overwrite):\n`);
    for (const p of plan.skipped) process.stdout.write(`  ${p}\n`);
  }

  if (dryRun) {
    process.stdout.write("\n(dry run — nothing written)\n");
    return;
  }

  if (!yes) {
    const proceed = await confirm("\n? Continue? (Y/n) ", true);
    if (!proceed) {
      process.stdout.write("Aborted.\n");
      process.exit(1);
    }
  }

  process.stdout.write("\n");
  for (const action of plan.actions) action();

  const cfg = readScaffoldConfig();
  process.stdout.write(`
Next steps:

  1. Pull the default classifier model:
       ollama pull ${cfg.runner.defaultModel}

  2. Verify everything is wired up:
       npx open-classify doctor

  3. Try it without writing code:
       npx open-classify try "hello"

  4. Use it from your code:
       import { createClassifier } from "open-classify";
       const { classify } = createClassifier();

     createClassifier() finds ./${PROJECT_DIRNAME}/config.json and wires
     in ./${PROJECT_DIRNAME}/classifiers/ automatically.

Docs:  https://github.com/taylorbayouth/open-classify#readme
`);
}

// Recursively plan a directory copy from source → dest, relative to projectCwd
// for display. Returns { actions, preview, skipped }.
function planScaffoldCopy(sourceDir, destDir, projectCwd, force) {
  const actions = [];
  const preview = [];
  const skipped = [];

  walk(sourceDir, destDir);

  return { actions, preview, skipped };

  function walk(src, dst) {
    if (!existsSync(dst)) {
      actions.push(() => {
        mkdirSync(dst, { recursive: true });
        process.stdout.write(`  created ${relative(projectCwd, dst)}/\n`);
      });
      preview.push(`${relative(projectCwd, dst)}/`);
    }

    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcChild = join(src, entry.name);
      const dstChild = join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(srcChild, dstChild);
      } else {
        const exists = existsSync(dstChild);
        if (exists && !force) {
          skipped.push(relative(projectCwd, dstChild));
          continue;
        }
        actions.push(() => {
          cpSync(srcChild, dstChild);
          process.stdout.write(`  wrote ${relative(projectCwd, dstChild)}\n`);
        });
        preview.push(relative(projectCwd, dstChild));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// eject
// ---------------------------------------------------------------------------

async function runEject({ cwd, name, yes, force, dryRun }) {
  if (!name) {
    process.stderr.write(`Usage: open-classify eject <name>\n\nAvailable: ${STOCK_NAMES.join(", ")}\n`);
    process.exit(1);
  }
  if (!STOCK_NAMES.includes(name)) {
    process.stderr.write(`✖  "${name}" is not a stock classifier.\n\nAvailable: ${STOCK_NAMES.join(", ")}\n`);
    process.exit(1);
  }

  const projectDir = join(cwd, PROJECT_DIRNAME);
  if (!existsSync(projectDir)) {
    process.stderr.write(
      `✖  ./${PROJECT_DIRNAME}/ not found. Run \`npx open-classify init\` first.\n`,
    );
    process.exit(1);
  }

  const source = join(STOCK_DIR, name);
  const dest = join(projectDir, "classifiers", name);
  const destRel = relative(cwd, dest);

  if (existsSync(dest) && !force) {
    process.stderr.write(
      `✖  ${destRel}/ already exists. Use --force to overwrite, or delete it first.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`\nEjecting "${name}" → ${destRel}/\n\n`);
  for (const filename of ["manifest.json", "prompt.md"]) {
    const srcFile = join(source, filename);
    const dstFile = join(dest, filename);
    process.stdout.write(`  ${relative(cwd, dstFile)}\n`);
  }

  if (dryRun) {
    process.stdout.write("\n(dry run — nothing written)\n");
    return;
  }

  if (!yes) {
    const proceed = await confirm("\n? Continue? (Y/n) ", true);
    if (!proceed) {
      process.stdout.write("Aborted.\n");
      process.exit(1);
    }
  }

  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });

  process.stdout.write(`
✓ ejected ${name}

The runtime now uses your local copy at ${destRel}/. Edit prompt.md or
manifest.json to taste. \`npm update open-classify\` won't touch these
files. To revert: delete the folder. If you want the package-owned
version to take over after that, add "${name}" to classifiers.stock in
${PROJECT_DIRNAME}/config.json.
`);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function runDoctor({ cwd }) {
  let allGood = true;

  // 1. package.json + open-classify dep.
  const pkg = readJsonIfExists(join(cwd, "package.json"));
  if (pkg === null) {
    process.stdout.write("✖  No package.json — not a Node project\n");
    allGood = false;
  } else if (isOpenClassifyDep(pkg)) {
    process.stdout.write("✓  open-classify found in package.json\n");
  } else {
    process.stdout.write("⚠  open-classify not listed as a dependency — run: npm install open-classify\n");
    allGood = false;
  }

  // 2. Config parses + catalog present.
  const projectDir = join(cwd, PROJECT_DIRNAME);
  const configPath = join(projectDir, "config.json");
  let config = null;
  if (!existsSync(configPath)) {
    process.stdout.write(`✖  ./${PROJECT_DIRNAME}/config.json not found — run: npx open-classify init\n`);
    allGood = false;
  } else {
    config = readJsonIfExists(configPath);
    if (config === null) {
      process.stdout.write(`✖  ./${PROJECT_DIRNAME}/config.json is not valid JSON\n`);
      allGood = false;
    } else {
      process.stdout.write(`✓  ./${PROJECT_DIRNAME}/config.json parses OK\n`);
      const catalogRel = config.catalog ?? "downstream-models.json";
      const catalogPath = resolve(projectDir, catalogRel);
      if (existsSync(catalogPath)) {
        process.stdout.write(`✓  catalog found at ${relative(cwd, catalogPath)}\n`);
      } else {
        process.stdout.write(`✖  catalog not found at ${relative(cwd, catalogPath)}\n`);
        allGood = false;
      }
    }
  }

  // 3. Ollama reachable + default model pulled.
  if (config !== null) {
    const host = config.runner?.host ?? "http://127.0.0.1:11434";
    const defaultModel = config.runner?.defaultModel ?? "gemma4:e4b-it-q4_K_M";
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        process.stdout.write(`✓  Ollama reachable at ${host}\n`);
        const data = await res.json();
        const pulled = data.models?.some((m) => m.name === defaultModel || m.model === defaultModel);
        if (pulled) {
          process.stdout.write(`✓  Model ${defaultModel} is available\n`);
        } else {
          process.stdout.write(`✖  Model ${defaultModel} not found — run: ollama pull ${defaultModel}\n`);
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
  }

  // 4. Classifier directories.
  if (config !== null) {
    const dirs = config.classifiers?.dirs ?? ["classifiers"];
    for (const dirRel of dirs) {
      const dir = resolve(projectDir, dirRel);
      const displayRel = relative(cwd, dir);
      if (!existsSync(dir)) {
        process.stdout.write(`ℹ  No ${displayRel}/ — run: npx open-classify init\n`);
        continue;
      }
      let active = 0;
      let bad = 0;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
          const sub = join(dir, entry.name);
          const ok = existsSync(join(sub, "manifest.json")) && existsSync(join(sub, "prompt.md"));
          if (ok) {
            active++;
          } else {
            process.stdout.write(`✖  ${displayRel}/${entry.name}/ is missing manifest.json or prompt.md\n`);
            bad++;
            allGood = false;
          }
        }
      } catch {/* skip */}
      if (bad === 0) {
        const stockEnabled = (config.classifiers?.stock ?? []).length;
        process.stdout.write(
          active > 0
            ? `✓  ${active} user classifier(s) in ${displayRel}/\n`
            : `ℹ  No user classifiers in ${displayRel}/${stockEnabled > 0 ? "" : " (use `npx open-classify eject <name>` to customize a stock classifier)"}\n`,
        );
        if (stockEnabled > 0) {
          process.stdout.write(`✓  ${stockEnabled} stock classifier(s) enabled in config\n`);
        }
      }
    }
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

  const configPath = join(cwd, PROJECT_DIRNAME, "config.json");
  if (!existsSync(configPath)) {
    process.stderr.write(`✖  ./${PROJECT_DIRNAME}/config.json not found — run: npx open-classify init\n`);
    process.exit(1);
  }

  let createClassifier;
  const candidates = [
    join(cwd, "node_modules", "open-classify", "dist", "src", "index.js"),
    join(PACKAGE_ROOT, "dist", "src", "index.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      ({ createClassifier } = await import(candidate));
      break;
    } catch {/* try next */}
  }

  if (!createClassifier) {
    process.stderr.write(
      "✖  Could not load the open-classify runtime.\n" +
      "   Is the package installed? Run: npm install open-classify\n",
    );
    process.exit(1);
  }

  let classifier;
  try {
    classifier = createClassifier({ configPath });
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
// Shared helpers
// ---------------------------------------------------------------------------

function requireHostProject(cwd) {
  if (!existsSync(join(cwd, "package.json"))) {
    process.stderr.write(
      `✖  No package.json found in ${cwd}.\n` +
      `   open-classify scaffolds into a Node project, so it needs one to live in.\n\n` +
      `   Create one first:  npm init -y\n`,
    );
    process.exit(1);
  }
}

function warnIfPackageMissing(cwd) {
  const pkg = readJsonIfExists(join(cwd, "package.json"));
  if (pkg === null || isOpenClassifyDep(pkg)) return;
  process.stdout.write(
    `\n⚠  open-classify is not yet a dependency of this project.\n` +
    `   Install it before importing from your code:\n\n` +
    `       npm install open-classify\n`,
  );
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function isOpenClassifyDep(pkg) {
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
    (f) => pkg[f]?.["open-classify"],
  );
}

function readScaffoldConfig() {
  return JSON.parse(readFileSync(join(SCAFFOLD_DIR, "config.json"), "utf8"));
}

function confirm(prompt, defaultYes = false) {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const v = (answer || "").trim().toLowerCase();
      resolveAnswer(defaultYes ? (v === "" || v === "y" || v === "yes") : (v === "y" || v === "yes"));
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
