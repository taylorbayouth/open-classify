import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyOpenClassifyInput,
  OpenClassifyClassifierError,
  OpenClassifyNormalizationError,
} from "../dist/src/pipeline.js";

const results = {
  preflight: { terminality: "continue", awk: "I'll take a look." },
  downstream_route: { execution_mode: "tool_assisted", model_tier: "local_strong" },
  context_sufficiency: {
    value: "self_contained",
    missing: [],
  },
  memory_retrieval_queries: { queries: ["user review preferences"] },
  tool_family_need: { value: ["workspace"] },
  message_and_attachment_digest: {
    slug: "review_request",
    summary: "The user wants a review.",
    attachments: [],
  },
  security_posture: { value: "normal", signals: [], notes: "No notable risk." },
};

test("starts all classifiers concurrently and returns continue result", async () => {
  const started = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "review this" }], raw: { kept: true } },
    {
      async runClassifier(name, input) {
        started.push(name);
        assert.equal(input.text, "review this");
        assert.deepEqual(input.conversation_window, [{ role: "user", text: "review this" }]);
        assert.equal("raw" in input, false);
        return results[name];
      },
    },
  );

  assert.equal(result.status, "continue");
  assert.deepEqual(started.sort(), Object.keys(results).sort());
  assert.equal(result.awk, "I'll take a look.");
  assert.equal(result.request.raw.kept, true);
  assert.deepEqual(result.classifiers, results);
});

test("terminal preflight aborts other classifiers and returns only preflight", async () => {
  const aborted = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "thanks" }] },
    {
      runClassifier(name, _input, signal) {
        if (name === "preflight") {
          return Promise.resolve({ terminality: "terminal", awk: "You're welcome." });
        }

        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.push(name);
              resolve(results[name]);
            },
            { once: true },
          );
        });
      },
    },
  );

  assert.equal(result.status, "terminal");
  assert.deepEqual(result.preflight, {
    terminality: "terminal",
    awk: "You're welcome.",
  });
  assert.equal("classifiers" in result, false);
  assert.equal(aborted.length, 6);
});

test("terminal preflight waits for aborted classifier runs to settle", async () => {
  const settledAfterAbort = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "thanks" }] },
    {
      runClassifier(name, _input, signal) {
        if (name === "preflight") {
          return Promise.resolve({ terminality: "terminal", awk: "You're welcome." });
        }

        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                settledAfterAbort.push(name);
                resolve(results[name]);
              }, 10);
            },
            { once: true },
          );
        });
      },
    },
  );

  assert.equal(result.status, "terminal");
  assert.equal(settledAfterAbort.length, 6);
});

test("unable_to_determine behaves like continue", async () => {
  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "ambiguous" }] },
    {
      async runClassifier(name) {
        if (name === "preflight") {
          return { terminality: "unable_to_determine", awk: "I'll take a look." };
        }
        return results[name];
      },
    },
  );

  assert.equal(result.status, "continue");
  assert.equal(result.classifiers.preflight.terminality, "unable_to_determine");
});

test("normalization failure rejects before classifiers start", async () => {
  let started = false;

  await assert.rejects(
    classifyOpenClassifyInput(
      { conversation_window: [{ role: "user", text: "\x00 " }] },
      {
        async runClassifier() {
          started = true;
          return results.preflight;
        },
      },
    ),
    OpenClassifyNormalizationError,
  );

  assert.equal(started, false);
});

test("classifier failure rejects the whole pipeline", async () => {
  await assert.rejects(
    classifyOpenClassifyInput(
      { conversation_window: [{ role: "user", text: "review this" }] },
      {
        async runClassifier(name) {
          if (name === "security_posture") {
            throw new Error("model unavailable");
          }
          return results[name];
        },
      },
    ),
    (error) =>
      error instanceof OpenClassifyClassifierError &&
      error.classifier === "security_posture" &&
      /model unavailable/.test(error.message),
  );
});
