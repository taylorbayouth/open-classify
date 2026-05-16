import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildClassifierRegistry,
  ClassifierManifestError,
} from "../dist/src/classifiers.js";
import { createClassifier } from "../dist/src/classify.js";
import {
  templateAsExtra,
  TEST_CATALOG,
  validClassifierOutputs as validOutputs,
} from "./fixtures.mjs";

function writeClassifier(root, name, manifestOverrides = {}, prompt = "Classify the message.") {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      purpose: `Custom classifier ${name}.`,
      dispatch_order: 1000,
      output_schema: {
        required: ["tags"],
        properties: {
          tags: {
            type: "array",
            maxItems: 5,
            items: { type: "string", minLength: 1, maxLength: 40 },
          },
        },
      },
      fallback: {
        reason: "Classifier failed.",
        certainty: "no_signal",
        tags: [],
      },
      ...manifestOverrides,
    }),
  );
  writeFileSync(join(dir, "prompt.md"), prompt);
  return dir;
}

test("buildClassifierRegistry merges extra dirs alongside built-ins", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "topic_tags");

  const bundle = buildClassifierRegistry({ extraDirs: [root] });

  assert.ok(bundle.names.includes("topic_tags"), "extra classifier should be registered");
  assert.ok(bundle.names.includes("preflight"), "built-ins should still be registered");
  assert.ok(
    bundle.modulesByName.topic_tags?.systemPrompt.includes("Classifier: topic_tags"),
    "extra classifier should have a composed system prompt",
  );
});

test("buildClassifierRegistry sorts merged manifests by dispatch_order", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  // dispatch_order=15 should land between preflight (10) and model_tier (20).
  writeClassifier(root, "early_custom", { dispatch_order: 15 });

  const bundle = buildClassifierRegistry({ extraDirs: [root] });
  const order = bundle.registry.map((m) => m.name);
  const preflightIdx = order.indexOf("preflight");
  const customIdx = order.indexOf("early_custom");
  const modelTierIdx = order.indexOf("model_tier");

  assert.ok(preflightIdx < customIdx, "early_custom should sort after preflight");
  assert.ok(customIdx < modelTierIdx, "early_custom should sort before model_tier");
});

test("buildClassifierRegistry throws when an extra collides with a mandatory built-in", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "preflight", {
    dispatch_order: 999,
    output_schema: {
      required: ["tags"],
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  });

  assert.throws(
    () => buildClassifierRegistry({ extraDirs: [root] }),
    (error) =>
      error instanceof ClassifierManifestError &&
      /duplicate classifier name: preflight/.test(error.message),
  );
});

test("buildClassifierRegistry throws when two extra dirs declare the same name", () => {
  const a = mkdtempSync(join(tmpdir(), "open-classify-extra-a-"));
  const b = mkdtempSync(join(tmpdir(), "open-classify-extra-b-"));
  writeClassifier(a, "topic_tags");
  writeClassifier(b, "topic_tags");

  assert.throws(
    () => buildClassifierRegistry({ extraDirs: [a, b] }),
    (error) =>
      error instanceof ClassifierManifestError &&
      /duplicate classifier name: topic_tags/.test(error.message),
  );
});

test("buildClassifierRegistry throws when an extra dir does not exist", () => {
  const missing = join(tmpdir(), `open-classify-missing-${Date.now()}`);
  assert.throws(
    () => buildClassifierRegistry({ extraDirs: [missing] }),
    (error) =>
      error instanceof ClassifierManifestError &&
      /classifier directory not found/.test(error.message),
  );
});

test("loader skips classifier directories whose names start with `_`", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "active_classifier");
  writeClassifier(root, "_dormant_classifier");

  const bundle = buildClassifierRegistry({ extraDirs: [root] });

  assert.ok(bundle.names.includes("active_classifier"));
  assert.equal(bundle.names.includes("_dormant_classifier"), false);
  assert.equal(bundle.names.includes("dormant_classifier"), false);
});

test("createClassifier runs extra classifiers through the pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "topic_tags");

  const seen = [];
  const { classify } = createClassifier({
    extraClassifierDirs: [root],
    catalog: TEST_CATALOG,
    runClassifier: async (name) => {
      seen.push(name);
      if (name === "topic_tags") {
        return {
          reason: "Detected one topic.",
          certainty: "strong",
          tags: ["review"],
        };
      }
      return validOutputs[name];
    },
  });

  const result = await classify({
    messages: [{ role: "user", text: "review this" }],
  });

  assert.ok(seen.includes("topic_tags"), "topic_tags should have been invoked");
  assert.equal(result.action, "route");
  assert.deepEqual(result.classifier_outputs.topic_tags.tags, ["review"]);
});

test("createClassifier exposes the merged registry bundle for introspection", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "topic_tags");

  const { registry } = createClassifier({
    extraClassifierDirs: [root],
    catalog: TEST_CATALOG,
    skipResourceCheck: true,
    fetch: async () => {
      throw new Error("fetch should not be called for introspection");
    },
  });

  assert.ok(registry.names.includes("topic_tags"));
  assert.ok(registry.names.includes("preflight"));
  assert.equal(typeof registry.modulesByName.topic_tags.systemPrompt, "string");
});

// ─── templates (the four non-mandatory classifiers in `templates/`) ──────────

test("templates are not loaded from the package by default", () => {
  const { names } = buildClassifierRegistry();
  for (const template of ["tools", "memory_retrieval_queries", "conversation_digest", "context_shift"]) {
    assert.equal(names.includes(template), false, `${template} must not be loaded by default`);
  }
});

test("stock classifiers load from the package when enabled", () => {
  const { names, modulesByName } = buildClassifierRegistry({
    stockClassifierNames: ["tools"],
  });
  assert.ok(names.includes("tools"));
  assert.equal(typeof modulesByName.tools.systemPrompt, "string");
});

test("unknown stock classifier names fail fast", () => {
  assert.throws(
    () => buildClassifierRegistry({ stockClassifierNames: ["definitely_not_real"] }),
    (error) =>
      error instanceof ClassifierManifestError &&
      /unknown stock classifier: definitely_not_real/.test(error.message),
  );
});

test("a template activates when copied into an extra dir", () => {
  const { names, modulesByName } = buildClassifierRegistry({
    extraDirs: [templateAsExtra("tools")],
  });
  assert.ok(names.includes("tools"));
  assert.equal(typeof modulesByName.tools.systemPrompt, "string");
});

test("only the four mandatory built-ins load by default", () => {
  const { names } = buildClassifierRegistry();
  assert.deepEqual(
    [...names].sort(),
    ["model_specialization", "model_tier", "preflight", "prompt_injection"],
  );
});
