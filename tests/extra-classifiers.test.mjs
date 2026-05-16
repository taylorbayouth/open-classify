import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILTIN_DEFAULT_DISABLED,
  buildClassifierRegistry,
  ClassifierManifestError,
} from "../dist/src/classifiers.js";
import { createClassifier } from "../dist/src/classify.js";
import { OpenClassifyConfigError } from "../dist/src/config.js";
import {
  builtinAsExtra,
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

test("buildClassifierRegistry throws when an extra collides with an active built-in", () => {
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

// ─── disabled mechanism ─────────────────────────────────────────────────────

test("tools is shipped disabled by default", () => {
  assert.deepEqual([...BUILTIN_DEFAULT_DISABLED], ["tools"]);
  const { names, modulesByName } = buildClassifierRegistry();
  assert.equal(names.includes("tools"), false);
  assert.equal(modulesByName.tools, undefined);
});

test("disabledClassifiers drops a built-in from the active registry", () => {
  const { names } = buildClassifierRegistry({
    disabledClassifiers: ["conversation_digest"],
  });
  assert.equal(names.includes("conversation_digest"), false);
  assert.ok(names.includes("preflight"));
});

test("disabledClassifiers drops an extra classifier", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  writeClassifier(root, "topic_tags");

  const { names } = buildClassifierRegistry({
    extraDirs: [root],
    disabledClassifiers: ["topic_tags"],
  });
  assert.equal(names.includes("topic_tags"), false);
});

test("disabledClassifiers rejects unknown names with a clear error", () => {
  assert.throws(
    () => buildClassifierRegistry({ disabledClassifiers: ["definitely_not_real"] }),
    (error) =>
      error instanceof ClassifierManifestError &&
      /disabled classifier "definitely_not_real" is not loaded/.test(error.message),
  );
});

test("copying a default-disabled built-in into extras activates it", () => {
  const { names, modulesByName } = buildClassifierRegistry({
    extraDirs: [builtinAsExtra("tools")],
  });
  assert.ok(names.includes("tools"));
  // The extra's manifest is the same as the bundled one — name collision is
  // avoided because the bundled tools is in the default-disabled set.
  assert.equal(typeof modulesByName.tools.systemPrompt, "string");
});

test("disabling a core built-in frees its name for an extra to override", () => {
  const root = mkdtempSync(join(tmpdir(), "open-classify-extra-"));
  // A minimal classifier with the same name as a core built-in.
  const dir = join(root, "preflight");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      name: "preflight",
      version: "1.0.0",
      purpose: "Custom preflight replacement.",
      dispatch_order: 5,
      reserved_fields: ["final_reply", "ack_reply"],
      fallback: {
        reason: "Custom preflight fallback.",
        certainty: "no_signal",
      },
    }),
  );
  writeFileSync(join(dir, "prompt.md"), "Decide whether to short-circuit.");

  const { names, modulesByName } = buildClassifierRegistry({
    extraDirs: [root],
    disabledClassifiers: ["preflight"],
  });

  // No collision — bundled preflight is disabled, so the extra preflight
  // takes the name.
  assert.ok(names.includes("preflight"));
  assert.match(
    modulesByName.preflight.fallback.reason,
    /Custom preflight fallback/,
  );
});

test("createClassifier honours disabledClassifiers from the programmatic option", async () => {
  const seen = [];
  const { classify } = createClassifier({
    catalog: TEST_CATALOG,
    disabledClassifiers: ["conversation_digest"],
    runClassifier: async (name) => {
      seen.push(name);
      return validOutputs[name];
    },
  });

  await classify({ messages: [{ role: "user", text: "review this" }] });
  assert.equal(seen.includes("conversation_digest"), false);
  assert.ok(seen.includes("preflight"));
});

test("createClassifier merges classifiers.disabled from the config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-config-"));
  const configPath = join(dir, "open-classify.config.json");
  writeFileSync(configPath, JSON.stringify({
    classifiers: { disabled: ["context_shift"] },
  }));

  const seen = [];
  const { classify } = createClassifier({
    configPath,
    catalog: TEST_CATALOG,
    disabledClassifiers: ["conversation_digest"],
    runClassifier: async (name) => {
      seen.push(name);
      return validOutputs[name];
    },
  });

  await classify({ messages: [{ role: "user", text: "review this" }] });
  assert.equal(seen.includes("context_shift"), false);
  assert.equal(seen.includes("conversation_digest"), false);
  assert.ok(seen.includes("preflight"));
});

test("createClassifier rejects runner.models entries that name an inactive classifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-config-"));
  const configPath = join(dir, "open-classify.config.json");
  // tools is default-disabled, so listing a model for it without enabling
  // tools as an extra is a configuration error.
  writeFileSync(configPath, JSON.stringify({
    runner: {
      provider: "ollama",
      models: { tools: "some-model" },
    },
  }));

  assert.throws(
    () =>
      createClassifier({
        configPath,
        catalog: TEST_CATALOG,
        skipResourceCheck: true,
      }),
    (error) =>
      error instanceof OpenClassifyConfigError &&
      /runner.models.tools is not an active classifier/.test(error.message),
  );
});
