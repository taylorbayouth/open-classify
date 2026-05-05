import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyOpenClassifyInput,
  OpenClassifyNormalizationError,
} from "../dist/src/pipeline.js";
import { userMessage, validClassifierOutputs as results } from "./fixtures.mjs";

test("starts all classifiers concurrently and returns route result", async () => {
  const started = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("review this")], raw: { kept: true } },
    {
      async runClassifier(name, input) {
        started.push(name);
        assert.equal(input.text, "review this");
        assert.deepEqual(input.conversation_window, [userMessage("review this")]);
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
  assert.deepEqual(
    Object.keys(result.classifier_status).sort(),
    Object.keys(results).sort(),
    "every classifier should appear in classifier_status",
  );
});

test("terminal preflight aborts other classifiers and returns only preflight", async () => {
  const aborted = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("thanks")] },
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
  assert.equal(result.classifier_status.preflight.ok, true);
  assert.equal(
    Object.keys(result.classifier_status).length,
    1,
    "terminal result reports status only for preflight",
  );
});

test("terminal preflight returns without waiting for slow aborted classifiers", async () => {
  const settledAfterAbort = [];

  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("thanks")] },
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

test("unable_to_determine preflight behaves like continue", async () => {
  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("ambiguous")] },
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
      { conversation_window: [userMessage("\x00 ")] },
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
    { conversation_window: [userMessage("review this")] },
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
    { conversation_window: [userMessage("review this")] },
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

test("preflight failure falls back to unable_to_determine and still routes", async () => {
  const attempts = {};

  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("review this")] },
    {
      async runClassifier(name) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        if (name === "preflight") {
          throw new Error("preflight model crashed");
        }
        return results[name];
      },
    },
  );

  assert.equal(result.decision, "route");
  assert.equal(attempts.preflight, 2);
  assert.equal(result.classifiers.preflight.terminality, "unable_to_determine");
  assert.equal(result.classifier_status.preflight.ok, false);
  assert.equal(result.classifier_status.preflight.source, "fallback");
  assert.equal(result.awk, result.classifiers.preflight.awk);
});

test("classifierRetryCount of 0 attempts each classifier exactly once", async () => {
  const attempts = {};

  const result = await classifyOpenClassifyInput(
    { conversation_window: [userMessage("review this")] },
    {
      classifierRetryCount: 0,
      async runClassifier(name) {
        attempts[name] = (attempts[name] ?? 0) + 1;
        if (name === "tools") {
          throw new Error("model unavailable");
        }
        return results[name];
      },
    },
  );

  assert.equal(result.decision, "route");
  assert.equal(attempts.tools, 1);
  assert.equal(result.classifier_status.tools.attempts, 1);
  assert.equal(result.classifier_status.tools.ok, false);
});
