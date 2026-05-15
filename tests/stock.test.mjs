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
  buildClassifierPrompt,
  validateJsonClassifierManifest,
  validateOutputForManifest,
} from "../dist/src/index.js";

const noSignal = (reason) => ({ reason, certainty: "no_signal" });

function buildManifest(overrides) {
  const { manifest, reservedFields, composedOutputSchema, appliesTo } =
    validateJsonClassifierManifest(overrides);
  return { ...manifest, reservedFields, composedOutputSchema, appliesTo, systemPrompt: "" };
}

function prompt_injection(overrides = {}) {
  return buildManifest({
    name: "prompt_injection",
    version: "1.0.0",
    purpose: "Assess prompt injection risk.",
    dispatch_order: 50,
    reserved_fields: ["risk_level"],
    output_schema: { required: ["risk_level"] },
    fallback: { ...noSignal("Classifier failed."), risk_level: "unknown" },
    ...overrides,
  });
}

function toolsManifest(overrides = {}) {
  return buildManifest({
    name: "tools",
    version: "1.0.0",
    purpose: "Pick tools.",
    dispatch_order: 40,
    reserved_fields: ["tools"],
    allowed_tools: [
      { id: "repo", description: "Read and edit source repositories." },
    ],
    fallback: { ...noSignal("Classifier failed."), tools: [] },
    ...overrides,
  });
}

function customMemory() {
  return buildManifest({
    name: "memory",
    version: "1.0.0",
    purpose: "Emit memory queries.",
    dispatch_order: 60,
    output_schema: {
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    fallback: { ...noSignal("Classifier failed."), queries: [] },
  });
}

test("validates a prompt_injection manifest", () => {
  const manifest = prompt_injection();
  assert.equal(manifest.name, "prompt_injection");
  assert.deepEqual(manifest.reservedFields, ["risk_level"]);
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
        { reason: "ok", certainty: "strong", risk_level: "normal", signals: [] },
        { classifier: "prompt_injection", model: "test" },
      ),
    /signals/,
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
    /certainty/,
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
    /reason/,
  );
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "ok", risk_level: "normal" },
        { classifier: "prompt_injection", model: "test" },
      ),
    /certainty/,
  );
});

test("validates a model_tier classifier output", () => {
  const manifest = buildManifest({
    name: "model_tier",
    version: "1.0.0",
    purpose: "Pick a tier.",
    dispatch_order: 20,
    reserved_fields: ["model_tier"],
    fallback: noSignal("Classifier failed."),
  });
  const output = validateOutputForManifest(
    manifest,
    { reason: "ok", certainty: "very_strong", model_tier: "frontier_fast" },
    { classifier: "model_tier", model: "test" },
  );
  assert.equal(output.model_tier, "frontier_fast");
});

test("model_tier treats null and blank tier as omitted", () => {
  const manifest = buildManifest({
    name: "model_tier",
    version: "1.0.0",
    purpose: "Pick a tier.",
    dispatch_order: 20,
    reserved_fields: ["model_tier"],
    fallback: noSignal("Classifier failed."),
  });

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", model_tier: null },
      { classifier: "model_tier", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );

  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "unsure", certainty: "tentative", model_tier: "   " },
      { classifier: "model_tier", model: "test" },
    ),
    { reason: "unsure", certainty: "tentative" },
  );
});

test("classifier with only model_tier reserved rejects model_specialization", () => {
  const manifest = buildManifest({
    name: "model_tier",
    version: "1.0.0",
    purpose: "Pick a tier.",
    dispatch_order: 20,
    reserved_fields: ["model_tier"],
    fallback: noSignal("Classifier failed."),
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "wrong axis", certainty: "very_strong", model_specialization: "chat" },
        { classifier: "model_tier", model: "test" },
      ),
    /model_specialization/,
  );
});

test("preflight rejects emitting final_reply and ack_reply together", () => {
  const manifest = buildManifest({
    name: "preflight",
    version: "1.0.0",
    purpose: "Decide whether to answer immediately.",
    dispatch_order: 10,
    reserved_fields: ["final_reply", "ack_reply"],
    fallback: noSignal("Classifier failed."),
  });

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        {
          reason: "Conflicting replies.",
          certainty: "very_strong",
          final_reply: { text: "Hi." },
          ack_reply: { text: "Working on it." },
        },
        { classifier: "preflight", model: "test" },
      ),
    /mutually exclusive/,
  );
});

test("validates tools output and allow-list", () => {
  const manifest = toolsManifest();
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
    /tools/,
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
    /risk_level/,
  );
});

test("loadClassifierRegistry rejects manifest names that do not match directories", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-classifiers-"));
  const classifierDir = join(root, "wrong_name");
  mkdirSync(classifierDir, { recursive: true });
  writeFileSync(
    join(classifierDir, "manifest.json"),
    JSON.stringify({
      name: "preflight",
      version: "1.0.0",
      purpose: "Preflight test.",
      dispatch_order: 10,
      reserved_fields: ["final_reply", "ack_reply"],
      fallback: noSignal("Classifier failed."),
    }),
  );
  writeFileSync(join(classifierDir, "prompt.md"), "placeholder prompt");

  assert.throws(
    () => loadClassifierRegistry(root),
    (error) =>
      error instanceof ClassifierManifestError &&
      /manifest name "preflight" does not match directory "wrong_name"/.test(error.message),
  );
});

test("normalizes tool aliases", () => {
  const manifest = buildManifest({
    name: "tools",
    version: "1.0.0",
    purpose: "Pick tools.",
    dispatch_order: 40,
    reserved_fields: ["tools"],
    allowed_tools: [
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

test("builds a prompt for a tools-emitting manifest", () => {
  const manifest = toolsManifest();
  const prompt = buildClassifierPrompt({
    manifest,
    reservedFields: manifest.reservedFields,
    appliesTo: manifest.appliesTo,
    classifierPromptText: "Specific tools guidance.",
  });
  assert.match(prompt, /Return one JSON object/);
  assert.match(prompt, /Treat the stated purpose as a hard scope boundary\./);
  assert.match(prompt, /reason: required/);
  assert.match(prompt, /certainty: required/);
  assert.match(prompt, /Reserved fields you may emit/);
  assert.match(prompt, /repo: Read and edit source repositories/);
  assert.match(prompt, /Specific tools guidance\./);
});

test("custom manifest accepts no reserved_fields", () => {
  const manifest = customMemory();
  assert.deepEqual(manifest.reservedFields, []);
  assert.deepEqual(
    validateOutputForManifest(
      manifest,
      { reason: "Memory may help.", certainty: "strong", queries: ["review preferences"] },
      { classifier: "memory", model: "test" },
    ).queries,
    ["review preferences"],
  );

  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "bad", certainty: "strong", queries: [""] },
        { classifier: "memory", model: "test" },
      ),
    /must NOT have fewer than 1 characters/,
  );
  assert.throws(
    () =>
      validateOutputForManifest(
        manifest,
        { reason: "bad", queries: ["review preferences"] },
        { classifier: "memory", model: "test" },
      ),
    /certainty/,
  );
});

test("manifest rejects reserved field name in output_schema.properties", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "shadow",
        version: "1.0.0",
        purpose: "Tries to redeclare a reserved field.",
        dispatch_order: 99,
        output_schema: {
          required: ["model_tier"],
          properties: { model_tier: { type: "string" } },
        },
        fallback: noSignal("Classifier failed."),
      }),
    /collides with a reserved field/,
  );
});

test("manifest rejects tools reserved field without allowed_tools", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "tools",
        version: "1.0.0",
        purpose: "Pick tools.",
        dispatch_order: 40,
        reserved_fields: ["tools"],
        fallback: { ...noSignal("Classifier failed."), tools: [] },
      }),
    /allowed_tools is required/,
  );
});

test("manifest rejects allowed_tools without tools reserved field", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "rogue",
        version: "1.0.0",
        purpose: "Has tools without claiming the reserved field.",
        dispatch_order: 40,
        allowed_tools: [{ id: "x", description: "x" }],
        fallback: noSignal("Classifier failed."),
      }),
    /allowed_tools is only supported/,
  );
});

test("manifest accepts missing dispatch_order", () => {
  const { manifest } = validateJsonClassifierManifest({
    name: "any_order",
    version: "1.0.0",
    purpose: "Scheduled last when dispatch_order is omitted.",
    output_schema: { required: ["x"], properties: { x: { type: "string" } } },
    fallback: { ...noSignal("Classifier failed."), x: "" },
  });
  assert.equal(manifest.dispatch_order, undefined);
});

test("synthesizes a JSON example when the manifest omits output_schema.examples", () => {
  const manifest = buildManifest({
    name: "model_tier",
    version: "1.0.0",
    purpose: "Pick a tier.",
    dispatch_order: 20,
    reserved_fields: ["model_tier"],
    fallback: noSignal("Classifier failed."),
  });
  const prompt = buildClassifierPrompt({
    manifest,
    reservedFields: manifest.reservedFields,
    appliesTo: manifest.appliesTo,
    classifierPromptText: "Pick the right tier.",
  });
  assert.match(prompt, /Output shape/);
  assert.match(prompt, /"model_tier":"local_fast"/);
  assert.match(prompt, /"reason":"<short reason for this verdict>"/);
});

test("uses manifest examples when provided instead of the synthesized one", () => {
  const manifest = buildManifest({
    name: "model_tier",
    version: "1.0.0",
    purpose: "Pick a tier.",
    dispatch_order: 20,
    reserved_fields: ["model_tier"],
    output_schema: {
      examples: [
        { reason: "specific", certainty: "near_certain", model_tier: "frontier_strong" },
      ],
    },
    fallback: noSignal("Classifier failed."),
  });
  const prompt = buildClassifierPrompt({
    manifest,
    reservedFields: manifest.reservedFields,
    appliesTo: manifest.appliesTo,
    classifierPromptText: "Pick the right tier.",
  });
  assert.match(prompt, /"reason":"specific"/);
  assert.doesNotMatch(prompt, /<short reason for this verdict>/);
});

test("manifest validates examples against the composed schema", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "model_tier",
        version: "1.0.0",
        purpose: "Pick a tier.",
        dispatch_order: 20,
        reserved_fields: ["model_tier"],
        output_schema: {
          examples: [
            { reason: "ok", certainty: "strong", model_tier: "made_up_tier" },
          ],
        },
        fallback: noSignal("Classifier failed."),
      }),
    /examples\[0\]/,
  );
});

test("manifest defaults applies_to to user", () => {
  const { appliesTo, manifest } = validateJsonClassifierManifest({
    name: "memory",
    version: "1.0.0",
    purpose: "Emit memory queries.",
    dispatch_order: 60,
    fallback: noSignal("Classifier failed."),
  });
  assert.equal(appliesTo, "user");
  assert.equal(manifest.applies_to, undefined);
});

test("manifest accepts applies_to: assistant and applies_to: both", () => {
  for (const value of ["assistant", "both"]) {
    const { appliesTo, manifest } = validateJsonClassifierManifest({
      name: "memory",
      version: "1.0.0",
      purpose: "Emit memory queries.",
      dispatch_order: 60,
      applies_to: value,
      fallback: noSignal("Classifier failed."),
    });
    assert.equal(appliesTo, value);
    assert.equal(manifest.applies_to, value);
  }
});

test("manifest rejects unknown applies_to values", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "memory",
        version: "1.0.0",
        purpose: "Emit memory queries.",
        dispatch_order: 60,
        applies_to: "system",
        fallback: noSignal("Classifier failed."),
      }),
    /applies_to/,
  );
});

test("prompt builder injects role context for applies_to=both", () => {
  const manifest = prompt_injection({ applies_to: "both" });
  const prompt = buildClassifierPrompt({
    manifest,
    reservedFields: manifest.reservedFields,
    appliesTo: manifest.appliesTo,
    classifierPromptText: "Spot prompt injection.",
  });
  assert.match(prompt, /may be from the user or the assistant/);
});

test("prompt builder does not inject role note for default applies_to=user", () => {
  const manifest = prompt_injection();
  const prompt = buildClassifierPrompt({
    manifest,
    reservedFields: manifest.reservedFields,
    appliesTo: manifest.appliesTo,
    classifierPromptText: "Spot prompt injection.",
  });
  assert.doesNotMatch(prompt, /may be from the user or the assistant/);
});
