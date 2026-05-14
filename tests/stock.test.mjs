import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ClassifierManifestError,
  loadClassifierRegistry,
} from "../dist/src/classifiers.js";
import { PROMPT_INJECTION_RISK_LEVEL_VALUES } from "../dist/src/enums.js";
import {
  buildStockClassifierPrompt,
  validateJsonClassifierManifest,
  validateOutputForManifest,
} from "../dist/src/index.js";

const noSignal = (reason) => ({ reason, certainty: "no_signal" });

function prompt_injection(overrides = {}) {
  return validateJsonClassifierManifest({
    kind: "stock",
    name: "prompt_injection",
    version: "1.0.0",
    purpose: "Assess prompt injection risk.",
    order: 50,
    fallback: { ...noSignal("Classifier failed."), risk_level: "unknown" },
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
    fallback: { ...noSignal("Classifier failed."), tools: [] },
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
    fallback: { ...noSignal("Classifier failed."), output: { queries: [] } },
  });
}

test("validates a stock prompt_injection manifest", () => {
  const manifest = prompt_injection();
  assert.equal(manifest.kind, "stock");
  assert.equal(manifest.name, "prompt_injection");
  assert.deepEqual(manifest.fallback, {
    reason: "Classifier failed.",
    certainty: "no_signal",
    risk_level: "unknown",
  });
});

test("rejects undeclared fields on a prompt_injection output", () => {
  const manifest = prompt_injection();
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { risk_level: "normal", signals: [] },
        { classifier: "prompt_injection", model: "test" },
      ),
    /signals is not a supported field/,
  );
});

test("validates certainty labels", () => {
  const manifest = prompt_injection();
  const output = validateOutputForManifest(
    manifest,
    { reason: "ok", certainty: "near_certain", risk_level: "normal" },
    { classifier: "prompt_injection", model: "test" },
  );
  assert.equal(output.certainty, "near_certain");
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "ok", certainty: "high", risk_level: "normal" },
        { classifier: "prompt_injection", model: "test" },
      ),
    /certainty has an unsupported value/,
  );
});

test("requires reason and certainty on classifier outputs", () => {
  const manifest = prompt_injection();
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { certainty: "strong", risk_level: "normal" },
        { classifier: "prompt_injection", model: "test" },
      ),
    /reason is required/,
  );
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "ok", risk_level: "normal" },
        { classifier: "prompt_injection", model: "test" },
      ),
    /certainty is required/,
  );
});

test("validates a routing classifier output", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "routing",
    version: "1.0.0",
    purpose: "Pick a tier.",
    order: 20,
    fallback: noSignal("Classifier failed."),
  });
  const output = validateOutputForManifest(
    manifest,
    { reason: "ok", certainty: "very_strong", model_tier: "frontier_fast" },
    { classifier: "routing", model: "test" },
  );
  assert.equal(output.model_tier, "frontier_fast");
});

test("routing treats null and blank tier as omitted", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "routing",
    version: "1.0.0",
    purpose: "Pick a tier.",
    order: 20,
    fallback: noSignal("Classifier failed."),
  });

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", model_tier: null },
      { classifier: "routing", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", model_tier: "   " },
      { classifier: "routing", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );
});

test("routing rejects specialization output", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "routing",
    version: "1.0.0",
    purpose: "Pick a tier.",
    order: 20,
    fallback: noSignal("Classifier failed."),
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "wrong axis", certainty: "very_strong", specialization: "chat" },
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
    fallback: noSignal("Classifier failed."),
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "wrong axis", certainty: "very_strong", model_tier: "frontier_fast" },
        { classifier: "model_specialization", model: "test" },
      ),
    /model_tier is not a supported field/,
  );
});

test("model_specialization treats null and blank specialization as omitted", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "model_specialization",
    version: "1.0.0",
    purpose: "Pick a specialization.",
    order: 30,
    fallback: noSignal("Classifier failed."),
  });

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", specialization: null },
      { classifier: "model_specialization", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", specialization: "" },
      { classifier: "model_specialization", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );
});

test("preflight rejects emitting final_reply and ack_reply together", () => {
  const manifest = validateJsonClassifierManifest({
    kind: "stock",
    name: "preflight",
    version: "1.0.0",
    purpose: "Decide whether to answer immediately.",
    order: 10,
    fallback: noSignal("Classifier failed."),
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        {
          reason: "Conflicting replies.",
          certainty: "very_strong",
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
      { reason: "Needs repo.", certainty: "very_strong", tools: ["repo"] },
      { classifier: "tools", model: "test" },
    ),
    { reason: "Needs repo.", certainty: "very_strong", tools: ["repo"] },
  );

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "Needs mail.", certainty: "very_strong", tools: ["email"] },
        { classifier: "tools", model: "test" },
      ),
    /unsupported tool email/,
  );
});

test("validates prompt_injection risk_level", () => {
  assert.ok(PROMPT_INJECTION_RISK_LEVEL_VALUES.includes("unknown"));

  const manifest = prompt_injection();
  const output = validateOutputForManifest(
    manifest,
    { reason: "Allow.", certainty: "very_strong", risk_level: "normal" },
    { classifier: "prompt_injection", model: "test" },
  );
  assert.equal(output.risk_level, "normal");

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "Bad.", certainty: "very_strong", risk_level: "not_real" },
        { classifier: "prompt_injection", model: "test" },
      ),
    /risk_level has an unsupported value/,
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
      fallback: noSignal("Classifier failed."),
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
    fallback: { ...noSignal("Classifier failed."), tools: [] },
  });
  const output = validateOutputForManifest(
    manifest,
    { reason: "Needs current data.", certainty: "very_strong", tools: ["web_browsing"] },
    { classifier: "tools", model: "test" },
  );
  assert.deepEqual(output.tools, ["web"]);
});

test("builds a prompt for a stock manifest", () => {
  const manifest = tools();
  const prompt = buildStockClassifierPrompt(manifest);
  assert.match(prompt, /Return one JSON object/);
  assert.match(prompt, /Treat the stated purpose as a hard scope boundary\./);
  assert.match(prompt, /reason: required compressed justification/);
  assert.match(prompt, /certainty: required certainty tag/);
  assert.match(prompt, /Shape: \{"reason":"\.\.\.","certainty":"strong","tools":\["workspace"\]\}/);
  assert.match(prompt, /repo: Read and edit source repositories/);
});

test("prompt_injection prompt scopes ordinary requests as non-injection by default", () => {
  const prompt = buildStockClassifierPrompt(prompt_injection());
  assert.match(prompt, /This classifier is only for prompt injection\./);
  assert.match(prompt, /Treat ordinary user requests such as "delete all files"/);
  assert.match(prompt, /Do not classify a request as suspicious merely because it is contradictory, impossible, destructive/);
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
        fallback: { ...noSignal("Classifier failed."), output: { queries: [] } },
      }),
    /output_schema is required/,
  );
});

test("custom classifier rejects a name colliding with a stock name", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        kind: "custom",
        name: "prompt_injection",
        version: "1.0.0",
        purpose: "shadow",
        order: 99,
        output_schema: { type: "object" },
        fallback: { ...noSignal("Classifier failed."), output: {} },
      }),
    /collides with a stock classifier/,
  );
});

test("custom output is validated against schema", () => {
  const manifest = customMemory();
  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "Memory may help.", certainty: "strong", output: { queries: ["review preferences"] } },
      { classifier: "memory", model: "test" },
    ).output,
    { queries: ["review preferences"] },
  );

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "bad", certainty: "strong", output: { queries: [""] } },
        { classifier: "memory", model: "test" },
      ),
    /must NOT have fewer than 1 characters/,
  );
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "bad", output: { queries: ["review preferences"] } },
        { classifier: "memory", model: "test" },
      ),
    /certainty is required/,
  );
});
