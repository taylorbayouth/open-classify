import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleResult,
  buildPublicOutputs,
} from "../dist/src/aggregator.js";
import { certaintyScore } from "../dist/src/stock.js";

const CATALOG = {
  default: "gpt-5.4-mini",
  models: [
    {
      id: "gpt-5.5",
      specializations: ["reasoning", "coding", "writing"],
      tier: "frontier_strong",
      params_in_billions: 800,
      context_window: 1_000_000,
      input_tokens_cpm: 5,
      cached_tokens_cpm: 0.5,
      output_tokens_cpm: 25,
    },
    {
      id: "gpt-5.3-codex",
      specializations: ["coding"],
      tier: "frontier_fast",
      params_in_billions: 30,
      context_window: 500_000,
      input_tokens_cpm: 0.4,
      cached_tokens_cpm: 0.05,
      output_tokens_cpm: 2,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["writing", "chat", "reasoning"],
      tier: "frontier_fast",
      params_in_billions: 15,
      context_window: 200_000,
      input_tokens_cpm: 0.25,
      cached_tokens_cpm: 0.03,
      output_tokens_cpm: 1.25,
    },
    {
      id: "qwen2.5-coder",
      specializations: ["coding"],
      tier: "local_strong",
      params_in_billions: 14,
      context_window: 128_000,
    },
  ],
};

// Minimal registry entry — only fields read by assembleResult.
function fake(name, dispatch_order, reservedFields = []) {
  return { name, dispatch_order, reservedFields };
}

const baseRegistry = [
  fake("preflight", 10, ["final_reply", "ack_reply"]),
  fake("model_tier", 20, ["model_tier"]),
  fake("model_specialization", 30, ["model_specialization"]),
  fake("tools", 40, ["tools"]),
  fake("prompt_injection", 50, ["risk_level"]),
  fake("memory", 60, []),
];

const baseResults = {
  preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
  model_tier: { reason: "tier", certainty: "very_strong", model_tier: "frontier_strong" },
  model_specialization: { reason: "spec", certainty: "very_strong", model_specialization: "reasoning" },
  tools: { reason: "tools", certainty: "very_strong", tools: ["web", "workspace"] },
  prompt_injection: { reason: "risk", certainty: "very_strong", risk_level: "normal" },
  memory: { reason: "a", certainty: "very_strong", queries: ["alpha"] },
};

test("assembleResult returns route when all classifiers succeed", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: baseResults,
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "route");
  assert.equal(result.block_reason, undefined);
  assert.equal(result.model_id, "gpt-5.5");
  assert.deepEqual(result.tools, ["web", "workspace"]);
  assert.deepEqual(result.reply, { text: "On it." });
  assert.deepEqual(result.prompt_injection, { risk_level: "normal" });
  assert.deepEqual(result.failed_classifiers, []);
});

test("assembleResult returns reply when preflight emits final_reply", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      preflight: { reason: "trivial", certainty: "near_certain", final_reply: { text: "Hi!" } },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "reply");
  assert.deepEqual(result.reply, { text: "Hi!" });
});

test("assembleResult blocks on high_risk prompt_injection", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      prompt_injection: { reason: "injection", certainty: "near_certain", risk_level: "high_risk" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "block");
  assert.equal(result.block_reason, "prompt_injection");
  assert.deepEqual(result.prompt_injection, { risk_level: "high_risk" });
  // model_id and reply still present for caller to store
  assert.ok(result.model_id !== null);
  assert.ok(result.reply !== null);
});

test("assembleResult blocks on unknown prompt_injection risk", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      prompt_injection: { reason: "unclear", certainty: "near_certain", risk_level: "unknown" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "block");
  assert.equal(result.block_reason, "prompt_injection");
});

test("assembleResult suspicious risk_level routes (not a block trigger)", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      prompt_injection: { reason: "weak", certainty: "weak", risk_level: "suspicious" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "route");
  assert.deepEqual(result.prompt_injection, { risk_level: "suspicious" });
});

test("assembleResult blocks with classification_error when classifiers fail", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      model_tier: { reason: "failed", certainty: "no_signal" },
    },
    failedClassifiers: ["model_tier"],
    catalog: CATALOG,
  });

  assert.equal(result.action, "block");
  assert.equal(result.block_reason, "classification_error");
  assert.deepEqual(result.failed_classifiers, ["model_tier"]);
});

test("assembleResult blocks when preflight emits no reply", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: {
      ...baseResults,
      preflight: { reason: "unclear", certainty: "no_signal" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.action, "block");
  assert.equal(result.block_reason, "classification_error");
  assert.equal(result.reply, null);
});

test("assembleResult picks highest-certainty contributor when two classifiers share a field", () => {
  const result = assembleResult({
    registry: [
      fake("preflight", 10, ["final_reply", "ack_reply"]),
      fake("model_tier", 20, ["model_tier"]),
      fake("secondary_tier", 25, ["model_tier"]),
      fake("prompt_injection", 50, ["risk_level"]),
    ],
    results: {
      preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
      model_tier: { reason: "weak", certainty: "reasonable", model_tier: "local_fast" },
      secondary_tier: { reason: "strong", certainty: "near_certain", model_tier: "frontier_strong" },
      prompt_injection: { reason: "ok", certainty: "very_strong", risk_level: "normal" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  // frontier_strong wins over local_fast
  assert.equal(result.model_id, "gpt-5.5");
});

test("assembleResult breaks ties by registry order (first wins)", () => {
  const result = assembleResult({
    registry: [
      fake("preflight", 10, ["final_reply", "ack_reply"]),
      fake("model_tier", 20, ["model_tier"]),
      fake("secondary_tier", 25, ["model_tier"]),
      fake("prompt_injection", 50, ["risk_level"]),
    ],
    results: {
      preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
      model_tier: { reason: "first", certainty: "very_strong", model_tier: "local_fast" },
      secondary_tier: { reason: "second", certainty: "very_strong", model_tier: "frontier_strong" },
      prompt_injection: { reason: "ok", certainty: "very_strong", risk_level: "normal" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  // local_fast wins (same certainty, first in registry order)
  assert.equal(result.model_id, "qwen2.5-coder");
});

test("assembleResult picks cheapest exact model match", () => {
  const result = assembleResult({
    registry: [
      fake("preflight", 10, ["final_reply", "ack_reply"]),
      fake("model_tier", 20, ["model_tier"]),
      fake("model_specialization", 30, ["model_specialization"]),
      fake("prompt_injection", 50, ["risk_level"]),
    ],
    results: {
      preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
      model_tier: { reason: "tier", certainty: "very_strong", model_tier: "frontier_fast" },
      model_specialization: { reason: "spec", certainty: "very_strong", model_specialization: "coding" },
      prompt_injection: { reason: "ok", certainty: "very_strong", risk_level: "normal" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(result.model_id, "gpt-5.3-codex");
});

test("buildPublicOutputs converts certainty labels to floats and keeps reason", () => {
  const registry = [fake("preflight", 10, ["final_reply", "ack_reply"]), fake("memory", 60, [])];
  const results = {
    preflight: { reason: "ack", certainty: "strong", ack_reply: { text: "On it." } },
    memory: { reason: "mem", certainty: "very_strong", queries: ["q1"] },
  };

  const out = buildPublicOutputs(registry, results);

  assert.equal(out.preflight.certainty, certaintyScore.strong);
  assert.equal(out.preflight.reason, "ack");
  assert.deepEqual(out.preflight.ack_reply, { text: "On it." });
  assert.equal(out.memory.certainty, certaintyScore.very_strong);
  assert.deepEqual(out.memory.queries, ["q1"]);
});

test("assembleResult avg and min certainty are floats", () => {
  const result = assembleResult({
    registry: baseRegistry,
    results: baseResults,
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.equal(typeof result.avg_certainty, "number");
  assert.equal(typeof result.min_certainty, "number");
  assert.ok(result.avg_certainty > 0 && result.avg_certainty <= 1);
  assert.equal(result.min_certainty, certaintyScore.very_strong);
});

test("assembleResult tools defaults to empty array when not emitted", () => {
  const result = assembleResult({
    registry: [
      fake("preflight", 10, ["final_reply", "ack_reply"]),
      fake("prompt_injection", 50, ["risk_level"]),
    ],
    results: {
      preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
      prompt_injection: { reason: "ok", certainty: "very_strong", risk_level: "normal" },
    },
    failedClassifiers: [],
    catalog: CATALOG,
  });

  assert.deepEqual(result.tools, []);
});
