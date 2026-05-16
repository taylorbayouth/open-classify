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
  return mkdtempSync(join(tmpdir(), "open-classify-init-"));
}

test("init scaffolds the standard layout", () => {
  const cwd = freshProject();
  const result = runCli(cwd, ["init", "--yes"]);

  assert.equal(result.status, 0, `exit code 0; stderr: ${result.stderr}`);

  assert.ok(existsSync(join(cwd, "open-classify.config.json")));
  const config = JSON.parse(readFileSync(join(cwd, "open-classify.config.json"), "utf8"));
  assert.equal(config.runner.provider, "ollama");
  assert.equal(config.catalog, "downstream-models.json");

  assert.ok(existsSync(join(cwd, "classifiers", "README.md")));
  for (const template of ["_conversation_digest", "_context_shift", "_memory_retrieval_queries", "_tools"]) {
    assert.ok(existsSync(join(cwd, "classifiers", template, "manifest.json")), `${template}/manifest.json missing`);
    assert.ok(existsSync(join(cwd, "classifiers", template, "prompt.md")), `${template}/prompt.md missing`);
  }

  assert.match(result.stdout, /wrote open-classify\.config\.json/);
  assert.match(result.stdout, /Wire it into your code/);
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
