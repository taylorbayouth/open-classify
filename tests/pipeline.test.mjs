import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyOpenClassifyInput,
  OpenClassifyNormalizationError,
} from "../dist/src/pipeline.js";

const results = {
  preflight: { terminality: "continue", awk: "Let me check." },
  routing: { execution_mode: "tool_assisted", model_tier: "local_strong" },
  context_sufficiency: {
    value: "self_contained",
    missing_context: [],
    relevant_context_summary: "",
  },
  memory_retrieval_queries: { queries: ["user review preferences"] },
  tools: { needed: true, families: ["workspace"] },
  message_and_attachment_digest: {
    slug: "review_request",
    summary: "The user wants a review.",
    attachments: [],
  },
  security: { risk_level: "normal", signals: [], notes: "No notable risk." },
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

  assert.equal(result.decision, "route");
  assert.deepEqual(started.sort(), Object.keys(results).sort());
  assert.equal(result.awk, "Let me check.");
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
          return Promise.resolve({ terminality: "terminal", awk: "Anytime." });
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

  assert.equal(result.decision, "terminal");
  assert.deepEqual(result.preflight, {
    terminality: "terminal",
    awk: "Anytime.",
  });
  assert.equal("classifiers" in result, false);
  assert.equal(aborted.length, 6);
});

test("terminal preflight returns without waiting for slow aborted classifiers", async () => {
  const settledAfterAbort = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "thanks" }] },
    {
      runClassifier(name, _input, signal) {
        if (name === "preflight") {
          return Promise.resolve({ terminality: "terminal", awk: "Anytime." });
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

  assert.equal(result.decision, "terminal");
  assert.equal(settledAfterAbort.length, 0);
});

test("unable_to_determine behaves like continue", async () => {
  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "ambiguous" }] },
    {
      async runClassifier(name) {
        if (name === "preflight") {
          return { terminality: "unable_to_determine", awk: "Let me check." };
        }
        return results[name];
      },
    },
  );

  assert.equal(result.decision, "route");
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

test("classifier failure retries once and falls back", async () => {
  const attempts = {};

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "review this" }] },
    {
      async runClassifier(name) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        if (name === "security") {
          throw new Error("model unavailable");
        }
        return results[name];
      },
    },
  );

  assert.equal(result.decision, "route");
  assert.equal(attempts.security, 2);
  assert.deepEqual(result.classifiers.security, {
    risk_level: "unable_to_determine",
    signals: [],
    notes: "Security classifier unavailable.",
  });
  assert.equal(result.classifier_status.security.ok, false);
  assert.equal(result.classifier_status.security.source, "fallback");
  assert.equal(result.classifier_status.security.attempts, 2);
  assert.match(result.classifier_status.security.error, /model unavailable/);
});

test("classifier timeout retries once and falls back even if signal is ignored", async () => {
  const attempts = {};

  const result = await classifyOpenClassifyInput(
    { conversation_window: [{ role: "user", text: "review this" }] },
    {
      classifierTimeoutMs: 5,
      async runClassifier(name) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        if (name === "routing") {
          return new Promise(() => {});
        }
        return results[name];
      },
    },
  );

  assert.equal(result.decision, "route");
  assert.equal(attempts.routing, 2);
  assert.deepEqual(result.classifiers.routing, {
    execution_mode: "direct",
    model_tier: "local_strong",
  });
  assert.equal(result.classifier_status.routing.ok, false);
  assert.equal(result.classifier_status.routing.reason, "timeout");
});
