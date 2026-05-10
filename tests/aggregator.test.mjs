import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  composeEnvelope,
  resolveModel,
} from "../dist/src/aggregator.js";

const CATALOG = {
  default: "gpt-5.4-mini",
  models: [
    {
      id: "gpt-5.5",
      specializations: ["reasoning", "coding", "writing"],
      execution_modes: ["direct", "tool_assisted", "workflow"],
      tiers: ["frontier_strong"],
      params_in_millions: 800_000,
      context_window: 1_000_000,
    },
    {
      id: "gpt-5.3-codex",
      specializations: ["coding"],
      execution_modes: ["direct", "tool_assisted"],
      tiers: ["frontier_fast"],
      params_in_millions: 30_000,
      context_window: 500_000,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["writing", "chat"],
      execution_modes: ["direct"],
      tiers: ["frontier_fast"],
      params_in_millions: 15_000,
      context_window: 200_000,
    },
    {
      id: "qwen2.5-coder",
      specializations: ["coding"],
      execution_modes: ["direct", "tool_assisted"],
      tiers: ["local_strong"],
      params_in_millions: 14_000,
      context_window: 128_000,
    },
  ],
};

const HIGH = 0.9;
const LOW = 0.1;

function specResult(value, confidence) {
  return {
    model_specialization: value,
    reason: "ok",
    confidence,
  };
}

function routingResult(execution_mode, model_tier, confidence) {
  return {
    execution_mode,
    model_tier,
    reason: "ok",
    confidence,
  };
}

// ─── resolveModel ───────────────────────────────────────────────────────────

test("resolveModel picks the single matching entry when all constraints confident", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", HIGH),
      routing: routingResult("tool_assisted", "frontier_fast", HIGH),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.3-codex");
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "coding",
    execution_mode: "tool_assisted",
    tier: "frontier_fast",
  });
});

test("resolveModel picks the model with most params when multiple match", () => {
  // Drop the tier constraint by being low-confidence about routing → both
  // frontier_strong gpt-5.5 and frontier_fast gpt-5.3-codex match.
  // Biggest wins.
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", HIGH),
      routing: routingResult("tool_assisted", "frontier_fast", LOW),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.5"); // 800_000 > 30_000
});

test("resolveModel drops low-confidence signals and records them", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", LOW),
      routing: routingResult("tool_assisted", "frontier_fast", LOW),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  // Zero confident constraints → biggest model in entire catalog wins
  assert.equal(rec.id, "gpt-5.5");
  const dropped = rec.resolution.constraints_dropped.map((d) => d.axis).sort();
  assert.deepEqual(dropped, ["execution_mode", "specialization", "tier"]);
  assert.equal(
    rec.resolution.constraints_dropped.every((d) => d.reason === "low_confidence"),
    true,
  );
});

test("resolveModel drops escape-hatch values", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("unclear", HIGH),
      routing: routingResult("unable_to_determine", "unable_to_determine", HIGH),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.5");
  const dropped = rec.resolution.constraints_dropped.map((d) => `${d.axis}:${d.reason}`).sort();
  assert.deepEqual(dropped, [
    "execution_mode:escape_hatch",
    "specialization:escape_hatch",
    "tier:escape_hatch",
  ]);
});

test("resolveModel falls back to catalog.default when no entry matches", () => {
  // No catalog entry has reasoning + workflow + local_fast — over-constrained.
  const rec = resolveModel(
    {
      model_specialization: specResult("reasoning", HIGH),
      routing: routingResult("workflow", "local_fast", HIGH),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.4-mini");
  assert.equal(rec.resolution.fell_back_to_default, true);
});

test("resolveModel surfaces confidences for both contributing classifiers", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", 0.7),
      routing: routingResult("tool_assisted", "frontier_strong", 0.81),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.resolution.confidences.model_specialization, 0.7);
  assert.equal(rec.resolution.confidences.routing, 0.81);
});

// ─── composeEnvelope ────────────────────────────────────────────────────────

// Minimal classifier-module shape — only the fields composeEnvelope needs.
function fakeModule(name, contributions = []) {
  return {
    name,
    version: "1.0.0",
    purpose: "",
    systemPrompt: "",
    validate: () => ({ reason: "", confidence: 0 }),
    fallback: { reason: "", confidence: 0 },
    contributions,
  };
}

test("composeEnvelope returns model_recommendation even with no classifiers", () => {
  const envelope = composeEnvelope({
    registry: [],
    results: {},
    catalog: CATALOG,
    input: { text: "hi", messages: [], attachments: [], target_message_hash: "deadbeef" },
  });
  assert.equal(envelope.model_recommendation.id, "gpt-5.5");
  assert.equal(envelope.model_recommendation.resolution.fell_back_to_default, false);
});

test("composeEnvelope unions memory_queries from multiple contributors", () => {
  const moduleA = fakeModule("a", [
    {
      slot: "memory_queries",
      priority: 0,
      build: () => ["alpha", "beta"],
    },
  ]);
  const moduleB = fakeModule("b", [
    {
      slot: "memory_queries",
      priority: 0,
      build: () => ["beta", "gamma"],
    },
  ]);
  const results = {
    a: { reason: "", confidence: 0.9 },
    b: { reason: "", confidence: 0.9 },
  };
  const envelope = composeEnvelope({
    registry: [moduleA, moduleB],
    results,
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  });
  assert.deepEqual(envelope.memory_queries, ["alpha", "beta", "gamma"]);
});

test("composeEnvelope picks highest-priority quick_reply contributor", () => {
  const moduleA = fakeModule("a", [
    {
      slot: "quick_reply",
      priority: 10,
      build: () => ({ text: "low priority", kind: "ack" }),
    },
  ]);
  const moduleB = fakeModule("b", [
    {
      slot: "quick_reply",
      priority: 0,
      build: () => ({ text: "high priority", kind: "ack" }),
    },
  ]);
  const results = {
    a: { reason: "", confidence: 0.9 },
    b: { reason: "", confidence: 0.9 },
  };
  const envelope = composeEnvelope({
    registry: [moduleA, moduleB],
    results,
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  });
  assert.deepEqual(envelope.quick_reply, { text: "high priority", kind: "ack" });
});

test("composeEnvelope is pure: same inputs produce structurally equal outputs", () => {
  const moduleA = fakeModule("a", [
    {
      slot: "memory_queries",
      priority: 0,
      build: () => ["q1", "q2"],
    },
  ]);
  const args = {
    registry: [moduleA],
    results: { a: { reason: "", confidence: 0.9 } },
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  };
  const e1 = composeEnvelope(args);
  const e2 = composeEnvelope(args);
  assert.deepEqual(e1, e2);
});

test("composeEnvelope mergeOverrides replaces the default merge", () => {
  const moduleA = fakeModule("a", [
    {
      slot: "memory_queries",
      priority: 0,
      build: () => ["alpha", "beta"],
    },
  ]);
  const moduleB = fakeModule("b", [
    {
      slot: "memory_queries",
      priority: 0,
      build: () => ["gamma"],
    },
  ]);
  const results = {
    a: { reason: "", confidence: 0.9 },
    b: { reason: "", confidence: 0.9 },
  };
  const envelope = composeEnvelope({
    registry: [moduleA, moduleB],
    results,
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
    config: {
      mergeOverrides: {
        memory_queries: (contributions) => contributions[0].value, // first wins, no union
      },
    },
  });
  assert.deepEqual(envelope.memory_queries, ["alpha", "beta"]);
});
