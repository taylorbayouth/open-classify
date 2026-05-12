import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ClassifierManifestError,
  loadClassifierRegistry,
} from "../dist/src/classifiers.js";
import { SECURITY_RISK_LEVEL_VALUES } from "../dist/src/enums.js";
import {
  buildStockClassifierPrompt,
  validateJsonClassifierManifest,
  validateOutputForManifest,
} from "../dist/src/index.js";

function security(overrides = {}) {
  return validateJsonClassifierManifest({
    kind: "stock",
    name: "security",
    version: "1.0.0",
    purpose: "Assess prompt injection risk.",
    order: 50,
    fallback: { risk_level: "unknown", signals: [] },
    ...overrides,
  });
}

function tools(overrides = {}) {
  return validateJsonClassifierManifest({
    kind: "stock",
    name: "tools",
    version: "1.0.0",
    purpose: "Pick tools.",
    order: 40,
    tools: [
      { id: "repo", description: "Read and edit source repositories." },
    ],
    fallback: { tools: [] },
    ...overrides,
  });
}

function customMemory() {
  return validateJsonClassifierManifest({
    kind: "custom",
    name: "memory",
    version: "1.0.0",
    purpose: "Emit memory queries.",
    order: 60,
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    fallback: { output: { queries: [] } },
  });
}

test("validates a stock security manifest", () => {
  const manifest = security();
  assert.equal(manifest.kind, "stock");
  assert.equal(manifest.name, "security");
  assert.deepEqual(manifest.fallback, { risk_level: "unknown", signals: [] });
});

test("rejects undeclared fields on a security output", () => {
  const manifest = security();
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { decision: "allow", risk_level: "normal", signals: [], extra: 1 },
        { classifier: "security", model: "test" },
      ),
    /extra is not a supported field/,
  );
});

test("normalizes common confidence formats", () => {
  const manifest = security();
  for (const [confidence, expected] of [
    [95, 0.95],
    ["95%", 0.95],
    ["high", 0.9],
  ]) {
    const output = validateOutputForManifest(
      manifest,
      { reason: "ok", confidence, decision: "allow", risk_level: "normal", signals: [] },
      { classifier: "security", model: "test" },
    );
    assert.equal(output.confidence, expected);
  }
});

test("validates a routing classifier output", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "routing",
    version: "1.0.0",
    purpose: "Pick a tier.",
    order: 20,
    fallback: {},
  });
  const output = validateOutputForManifest(
    manifest,
    { reason: "ok", confidence: 0.9, model_tier: "frontier_fast" },
    { classifier: "routing", model: "test" },
  );
  assert.equal(output.model_tier, "frontier_fast");
});

test("routing rejects specialization output", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "routing",
    version: "1.0.0",
    purpose: "Pick a tier.",
    order: 20,
    fallback: {},
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "wrong axis", confidence: 0.9, specialization: "question_answering" },
        { classifier: "routing", model: "test" },
      ),
    /specialization is not a supported field/,
  );
});

test("model_specialization rejects tier output", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "model_specialization",
    version: "1.0.0",
    purpose: "Pick a specialization.",
    order: 30,
    fallback: {},
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "wrong axis", confidence: 0.9, model_tier: "frontier_fast" },
        { classifier: "model_specialization", model: "test" },
      ),
    /model_tier is not a supported field/,
  );
});

test("preflight rejects emitting final_reply and ack_reply together", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "preflight",
    version: "1.0.0",
    purpose: "Decide whether to answer immediately.",
    order: 10,
    fallback: {},
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        {
          reason: "Conflicting replies.",
          confidence: 0.9,
          final_reply: { reply: "Hi." },
          ack_reply: { reply: "Working on it." },
        },
        { classifier: "preflight", model: "test" },
      ),
    /mutually exclusive/,
  );
});

test("validates tools output and allow-list", () => {
  const manifest = tools();
  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "Needs repo.", confidence: 0.88, tools: ["repo"] },
      { classifier: "tools", model: "test" },
    ),
    { reason: "Needs repo.", confidence: 0.88, tools: ["repo"] },
  );

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "Needs mail.", confidence: 0.88, tools: ["email"] },
        { classifier: "tools", model: "test" },
      ),
    /unsupported tool email/,
  );
});

test("validates safety risk_level / signals / decision consistency", () => {
  assert.ok(SECURITY_RISK_LEVEL_VALUES.includes("unknown"));

  const manifest = security();
  const output = validateOutputForManifest(
    manifest,
    { reason: "Allow.", confidence: 0.9, decision: "allow", risk_level: "normal", signals: [] },
    { classifier: "security", model: "test" },
  );
  assert.equal(output.decision, "allow");

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "Bad.", confidence: 0.9, decision: "block", risk_level: "suspicious", signals: ["instruction_attack"] },
        { classifier: "security", model: "test" },
      ),
    /block requires high_risk/,
  );
});

test("loadClassifierRegistry rejects manifest names that do not match directories", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-classifiers-"));
  const classifierDir = join(root, "stock", "wrong_name");
  mkdirSync(classifierDir, { recursive: true });
  writeFileSync(
    join(classifierDir, "manifest.json"),
    JSON.stringify({
      kind: "stock",
      name: "preflight",
      version: "1.0.0",
      purpose: "Preflight test.",
      order: 10,
      fallback: {},
    }),
  );

  assert.throws(
    () => loadClassifierRegistry(root),
    (error) =>
      error instanceof ClassifierManifestError &&
      /manifest name "preflight" does not match directory "wrong_name"/.test(error.message),
  );
});

test("normalizes tool aliases", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "tools",
    version: "1.0.0",
    purpose: "Pick tools.",
    order: 40,
    tools: [
      { id: "web", description: "Public web browsing." },
    ],
    fallback: { tools: [] },
  });
  const output = validateOutputForManifest(
    manifest,
    { reason: "Needs current data.", confidence: 0.88, tools: ["web_browsing"] },
    { classifier: "tools", model: "test" },
  );
  assert.deepEqual(output.tools, ["web"]);
});

test("builds a prompt for a stock manifest", () => {
  const manifest = tools();
  const prompt = buildStockClassifierPrompt(manifest);
  assert.match(prompt, /Return one JSON object/);
  assert.match(prompt, /Treat the stated purpose as a hard scope boundary\./);
  assert.match(prompt, /repo: Read and edit source repositories/);
});

test("security prompt scopes ordinary tool constraints as non-safety by default", () => {
  const prompt = buildStockClassifierPrompt(security());
  assert.match(prompt, /This classifier is only for safety and permission-boundary risk\./);
  assert.match(prompt, /Treat ordinary user constraints such as "do not browse", "do not send", "cite the source", or "use\/avoid tool X" as normal task requirements/);
  assert.match(prompt, /Do not classify a request as suspicious merely because it is contradictory, impossible, or asks for freshness without the required tool/);
});

test("custom manifest requires output_schema", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        kind: "custom",
        name: "memory",
        version: "1.0.0",
        purpose: "Emit memory queries.",
        order: 60,
        fallback: { output: { queries: [] } },
      }),
    /output_schema is required/,
  );
});

test("custom classifier rejects a name colliding with a stock name", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        kind: "custom",
        name: "security",
        version: "1.0.0",
        purpose: "shadow",
        order: 99,
        output_schema: { type: "object" },
        fallback: { output: {} },
      }),
    /collides with a stock classifier/,
  );
});

test("custom output is validated against schema", () => {
  const manifest = customMemory();
  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "Memory may help.", confidence: 0.8, output: { queries: ["review preferences"] } },
      { classifier: "memory", model: "test" },
    ).output,
    { queries: ["review preferences"] },
  );

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "bad", confidence: 0.8, output: { queries: [""] } },
        { classifier: "memory", model: "test" },
      ),
    /must NOT have fewer than 1 characters/,
  );
});
