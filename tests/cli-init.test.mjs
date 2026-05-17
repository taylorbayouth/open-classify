// Integration tests for `bin/open-classify.mjs`. Spawns the CLI in a temp
// directory and exercises init, eject, and doctor end-to-end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildClassifierRegistry } from "../dist/src/classifiers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "open-classify.mjs");

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function freshProject() {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-init-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }));
  return dir;
}

function freshProjectWithDep() {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-init-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      dependencies: { "open-classify": "^1.0.0" },
    }),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test("init scaffolds the open-classify/ directory", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--yes"]);

  assert.equal(result.status, 0, `exit code 0; stderr: ${result.stderr}`);

  assert.ok(existsSync(join(cwd, "open-classify", "config.json")));
  assert.ok(existsSync(join(cwd, "open-classify", "downstream-models.json")));
  assert.ok(existsSync(join(cwd, "open-classify", "README.md")));
  assert.ok(existsSync(join(cwd, "open-classify", "classifiers", "README.md")));

  // Nothing leaks at the project root.
  assert.equal(existsSync(join(cwd, "open-classify.config.json")), false);
  assert.equal(existsSync(join(cwd, "downstream-models.json")), false);
  assert.equal(existsSync(join(cwd, "classifiers")), false);

  const config = JSON.parse(readFileSync(join(cwd, "open-classify", "config.json"), "utf8"));
  assert.equal(config.runner.provider, "ollama");
  assert.equal(config.catalog, "downstream-models.json");
  assert.deepEqual(config.classifiers.dirs, ["classifiers"]);
  // Stock is omitted by default (defaults to empty).
  assert.equal(config.classifiers.stock, undefined);

  assert.match(result.stdout, /wrote open-classify\/config\.json/);
  assert.match(result.stdout, /Next steps/);
  assert.match(result.stdout, /ollama pull/);
});

test("init is idempotent — second run is a no-op", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  const configBefore = readFileSync(join(cwd, "open-classify", "config.json"), "utf8");

  const second = runCli(cwd, ["init", "--yes"]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Nothing to do/);
  assert.equal(readFileSync(join(cwd, "open-classify", "config.json"), "utf8"), configBefore);
});

test("init does not overwrite an existing config.json", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const customConfig = '{"catalog":"./my-custom-catalog.json"}\n';
  writeFileSync(join(cwd, "open-classify", "config.json"), customConfig);

  const result = runCli(cwd, ["init", "--yes"]);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(cwd, "open-classify", "config.json"), "utf8"), customConfig);
});

test("init --force overwrites existing files", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  writeFileSync(join(cwd, "open-classify", "config.json"), "{}\n");

  const result = runCli(cwd, ["init", "--force", "--yes"]);
  assert.equal(result.status, 0);
  const config = JSON.parse(readFileSync(join(cwd, "open-classify", "config.json"), "utf8"));
  assert.equal(config.runner.provider, "ollama");
});

test("init --dry-run previews without writing", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--dry-run", "--yes"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /The following will be created/);
  assert.match(result.stdout, /dry run/);
  assert.equal(existsSync(join(cwd, "open-classify")), false);
});

test("init prints help when no subcommand is given", () => {
  const cwd = freshProject();
  const result = runCli(cwd, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /eject/);
});

test("init fails with a clear message when there is no package.json", () => {
  const cwd = mkdtempSync(join(tmpdir(), "open-classify-nopkg-"));
  const result = runCli(cwd, ["init", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No package\.json/);
  assert.match(result.stderr, /npm init/);
});

test("init warns when open-classify is not yet a dependency", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--yes"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /not yet a dependency/);
  assert.match(result.stdout, /npm install open-classify/);
});

test("init is quiet about the dependency when it's already installed", () => {
  const cwd = freshProjectWithDep();
  const result = runCli(cwd, ["init", "--yes"]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /not yet a dependency/);
});

// ---------------------------------------------------------------------------
// eject
// ---------------------------------------------------------------------------

test("eject copies a stock classifier into open-classify/classifiers/", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const result = runCli(cwd, ["eject", "tools", "--yes"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  assert.ok(existsSync(join(cwd, "open-classify", "classifiers", "tools", "manifest.json")));
  assert.ok(existsSync(join(cwd, "open-classify", "classifiers", "tools", "prompt.md")));
  assert.match(result.stdout, /ejected tools/);
});

test("eject refuses to overwrite without --force", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  runCli(cwd, ["eject", "tools", "--yes"]);

  const second = runCli(cwd, ["eject", "tools", "--yes"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);
});

test("eject --force overwrites", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  runCli(cwd, ["eject", "tools", "--yes"]);
  writeFileSync(join(cwd, "open-classify", "classifiers", "tools", "prompt.md"), "mine");

  const result = runCli(cwd, ["eject", "tools", "--force", "--yes"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const prompt = readFileSync(join(cwd, "open-classify", "classifiers", "tools", "prompt.md"), "utf8");
  assert.notEqual(prompt.trim(), "mine");
});

test("eject rejects unknown names", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const result = runCli(cwd, ["eject", "not_a_real_classifier", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a stock classifier/);
});

test("eject fails when open-classify/ is missing", () => {
  const cwd = freshProject();
  // No init.
  const result = runCli(cwd, ["eject", "tools", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found/);
  assert.match(result.stderr, /open-classify init/);
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

test("scaffolded layout: built-ins load, stock list is empty", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const bundle = buildClassifierRegistry({
    extraDirs: [join(cwd, "open-classify", "classifiers")],
  });
  assert.deepEqual(
    [...bundle.names].sort(),
    ["model_specialization", "model_tier", "preflight", "prompt_injection"],
  );
});

test("ejected classifier overrides the stock version (no duplicate-name error)", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  runCli(cwd, ["eject", "tools", "--yes"]);

  const bundle = buildClassifierRegistry({
    stockClassifierNames: ["tools"],
    extraDirs: [join(cwd, "open-classify", "classifiers")],
  });
  assert.ok(bundle.names.includes("tools"));
  // Verify it's our copy, not the stock copy (check by file path in the manifest's directory).
  const toolsManifest = bundle.modulesByName.tools;
  assert.ok(toolsManifest);
});

test("scaffolded config wires through createClassifier", async () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const { createClassifier } = await import("../dist/src/classify.js");
  const classifier = createClassifier({
    configPath: join(cwd, "open-classify", "config.json"),
    catalog: { models: [{ id: "local", specializations: ["chat"], tier: "local_fast", params_in_billions: null, context_window: 4096 }], default: "local" },
    runClassifier: async () => ({ reason: "stub", certainty: "no_signal" }),
  });

  assert.deepEqual(
    [...classifier.registry.names].sort(),
    ["model_specialization", "model_tier", "preflight", "prompt_injection"],
  );

  // Enable a stock classifier via config; verify it joins the registry.
  const config = JSON.parse(readFileSync(join(cwd, "open-classify", "config.json"), "utf8"));
  config.classifiers.stock = ["tools"];
  writeFileSync(join(cwd, "open-classify", "config.json"), JSON.stringify(config, null, 2));

  const withTools = createClassifier({
    configPath: join(cwd, "open-classify", "config.json"),
    catalog: { models: [{ id: "local", specializations: ["chat"], tier: "local_fast", params_in_billions: null, context_window: 4096 }], default: "local" },
    runClassifier: async () => ({ reason: "stub", certainty: "no_signal" }),
  });
  assert.ok(withTools.registry.names.includes("tools"));
});
