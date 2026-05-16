// Integration tests for `bin/open-classify.mjs init`. Spawns the CLI in a
// temp directory and verifies the scaffolded layout, idempotency, and
// behaviour around activated templates.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

test("init scaffolds the standard layout", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--yes"]);

  assert.equal(result.status, 0, `exit code 0; stderr: ${result.stderr}`);

  assert.ok(existsSync(join(cwd, "open-classify.config.json")));
  assert.ok(existsSync(join(cwd, "downstream-models.json")));
  const config = JSON.parse(readFileSync(join(cwd, "open-classify.config.json"), "utf8"));
  assert.equal(config.runner.provider, "ollama");
  assert.equal(config.catalog, "downstream-models.json");
  assert.deepEqual(config.classifiers.dirs, ["classifiers"]);
  assert.equal(config.classifiers.stock.tools, false);

  assert.ok(existsSync(join(cwd, "classifiers", "README.md")));
  for (const template of ["_conversation_digest", "_context_shift", "_memory_retrieval_queries", "_tools"]) {
    assert.ok(existsSync(join(cwd, "classifiers", template, "manifest.json")), `${template}/manifest.json missing`);
    assert.ok(existsSync(join(cwd, "classifiers", template, "prompt.md")), `${template}/prompt.md missing`);
  }

  assert.match(result.stdout, /wrote open-classify\.config\.json/);
  assert.match(result.stdout, /wrote downstream-models\.json/);
  assert.match(result.stdout, /Next steps/);
  assert.match(result.stdout, /ollama pull/);
});

test("init is idempotent — second run is a no-op", () => {
  const cwd = freshProject();
  const first = runCli(cwd, ["init", "--yes"]);
  assert.equal(first.status, 0);
  const configBefore = readFileSync(join(cwd, "open-classify.config.json"), "utf8");

  const second = runCli(cwd, ["init", "--yes"]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /Nothing to do/);
  assert.equal(readFileSync(join(cwd, "open-classify.config.json"), "utf8"), configBefore);
});

test("init leaves activated templates alone on re-run", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  renameSync(join(cwd, "classifiers", "_tools"), join(cwd, "classifiers", "tools"));

  const result = runCli(cwd, ["init", "--yes"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Nothing to do/);
  // Activated tools/ stayed put; no replacement _tools/ was scaffolded.
  assert.ok(existsSync(join(cwd, "classifiers", "tools")));
  assert.equal(existsSync(join(cwd, "classifiers", "_tools")), false);
});

test("scaffolded layout produces a working registry after activation", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  // Before activation: only mandatory built-ins.
  const before = buildClassifierRegistry({ extraDirs: [join(cwd, "classifiers")] });
  assert.deepEqual(
    [...before.names].sort(),
    ["model_specialization", "model_tier", "preflight", "prompt_injection"],
  );

  // Activate tools by dropping the underscore.
  renameSync(join(cwd, "classifiers", "_tools"), join(cwd, "classifiers", "tools"));

  const after = buildClassifierRegistry({ extraDirs: [join(cwd, "classifiers")] });
  assert.ok(after.names.includes("tools"));
});

test("scaffolded config wires classifier dirs and stock classifiers into createClassifier", async () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const { createClassifier } = await import("../dist/src/classify.js");
  const classifier = createClassifier({
    configPath: join(cwd, "open-classify.config.json"),
    catalog: { models: [{ id: "local", specializations: ["general"], tier: "local_fast", params_in_billions: null, context_window: 4096 }], default: "local" },
    runClassifier: async (name) => ({
      reason: `stub ${name}`,
      certainty: "no_signal",
      ...(name === "preflight" ? {} : {}),
    }),
  });

  assert.deepEqual(
    [...classifier.registry.names].sort(),
    ["model_specialization", "model_tier", "preflight", "prompt_injection"],
  );

  const config = JSON.parse(readFileSync(join(cwd, "open-classify.config.json"), "utf8"));
  config.classifiers.stock.tools = true;
  writeFileSync(join(cwd, "open-classify.config.json"), JSON.stringify(config, null, 2));

  const withTools = createClassifier({
    configPath: join(cwd, "open-classify.config.json"),
    catalog: { models: [{ id: "local", specializations: ["general"], tier: "local_fast", params_in_billions: null, context_window: 4096 }], default: "local" },
    runClassifier: async () => ({ reason: "stub", certainty: "no_signal" }),
  });

  assert.ok(withTools.registry.names.includes("tools"));
});

test("init does not overwrite an existing config", () => {
  const cwd = freshProject();
  const customConfig = '{"catalog":"./my-custom-catalog.json"}\n';
  writeFileSync(join(cwd, "open-classify.config.json"), customConfig);

  const result = runCli(cwd, ["init", "--yes"]);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(cwd, "open-classify.config.json"), "utf8"), customConfig);
  // The templates were still scaffolded.
  assert.ok(existsSync(join(cwd, "classifiers", "_tools")));
});

test("init prints help when no subcommand is given", () => {
  const cwd = freshProject();
  const result = runCli(cwd, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /init/);
});

test("init fails with a clear message when there is no package.json", () => {
  // Use a raw temp dir — no package.json written.
  const cwd = mkdtempSync(join(tmpdir(), "open-classify-nopkg-"));
  const result = runCli(cwd, ["init", "--yes"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No package\.json/);
  assert.match(result.stderr, /npm init/);
});

test("init --dry-run previews without writing any files", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--dry-run", "--yes"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /The following will be created/);
  assert.match(result.stdout, /dry run/);
  // Nothing should have been written.
  assert.equal(existsSync(join(cwd, "open-classify.config.json")), false);
  assert.equal(existsSync(join(cwd, "classifiers")), false);
});

test("init --minimal writes runtime config and catalog only", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--minimal", "--yes"]);
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(cwd, "open-classify.config.json")));
  assert.ok(existsSync(join(cwd, "downstream-models.json")));
  assert.equal(existsSync(join(cwd, "classifiers")), false);
});

test("init --force overwrites an existing config", () => {
  const cwd = freshProject();
  const customConfig = '{"catalog":"./my-custom-catalog.json"}\n';
  writeFileSync(join(cwd, "open-classify.config.json"), customConfig);

  const result = runCli(cwd, ["init", "--force", "--yes"]);
  assert.equal(result.status, 0);
  // Config should have been replaced with the default.
  const config = JSON.parse(readFileSync(join(cwd, "open-classify.config.json"), "utf8"));
  assert.equal(config.runner.provider, "ollama");
  // Activated classifiers should NOT have been overwritten.
  assert.ok(existsSync(join(cwd, "classifiers", "_tools")));
});

test("uninstall removes scaffolded files and inactive templates", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);

  const result = runCli(cwd, ["uninstall", "--yes"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  assert.equal(existsSync(join(cwd, "open-classify.config.json")), false);
  assert.equal(existsSync(join(cwd, "downstream-models.json")), false);
  assert.equal(existsSync(join(cwd, "classifiers")), false);
});

test("uninstall keeps active/custom classifiers unless forced", () => {
  const cwd = freshProject();
  runCli(cwd, ["init", "--yes"]);
  renameSync(join(cwd, "classifiers", "_tools"), join(cwd, "classifiers", "tools"));
  writeFileSync(join(cwd, "classifiers", "notes.txt"), "custom");

  const result = runCli(cwd, ["uninstall", "--yes"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(existsSync(join(cwd, "classifiers", "tools")));
  assert.ok(existsSync(join(cwd, "classifiers", "notes.txt")));

  const force = runCli(cwd, ["uninstall", "--force", "--yes"]);
  assert.equal(force.status, 0, `stderr: ${force.stderr}`);
  assert.equal(existsSync(join(cwd, "classifiers")), false);
});
