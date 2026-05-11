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
      execution_modes: ["direct", "tool_assisted"],
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
      execution_modes: ["direct", "tool_assisted", "workflow"],
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
      execution_modes: ["direct", "tool_assisted"],
      tier: "local_strong",
      params_in_billions: 14,
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
  assert.equal(rec.params_in_billions, 30);
  assert.equal(rec.input_tokens_cpm, 0.4);
  assert.equal(rec.cached_tokens_cpm, 0.05);
  assert.equal(rec.output_tokens_cpm, 2);
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "coding",
    execution_mode: "tool_assisted",
    tier: "frontier_fast",
  });
});

test("resolveModel picks cheapest adequate when multiple models match", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", HIGH),
      routing: routingResult("tool_assisted", "frontier_fast", LOW),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "qwen2.5-coder"); // missing pricing ranks as zero external cost
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
  // Zero confident constraints → cheapest adequate model wins, then larger size
  assert.equal(rec.id, "qwen2.5-coder");
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
  assert.equal(rec.id, "qwen2.5-coder");
  const dropped = rec.resolution.constraints_dropped.map((d) => `${d.axis}:${d.reason}`).sort();
  assert.deepEqual(dropped, [
    "execution_mode:escape_hatch",
    "specialization:escape_hatch",
    "tier:escape_hatch",
  ]);
});

test("resolveModel relaxes tier before specialization when exact tier has no match", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("reasoning", HIGH),
      routing: routingResult("workflow", "local_fast", HIGH),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.4-mini");
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "reasoning",
    execution_mode: "workflow",
  });
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "tier", reason: "no_match_relaxed" },
  ]);
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

test("resolveModel ties on price by picking the larger model", () => {
  const catalog = {
    default: "small",
    models: [
      {
        id: "small",
        specializations: ["chat"],
        execution_modes: ["direct"],
        tier: "local_strong",
        params_in_billions: 4,
        context_window: 200_000,
      },
      {
        id: "large",
        specializations: ["chat"],
        execution_modes: ["direct"],
        tier: "local_strong",
        params_in_billions: 14,
        context_window: 128_000,
      },
    ],
  };
  const rec = resolveModel(
    {
      model_specialization: specResult("chat", HIGH),
      routing: routingResult("direct", "local_strong", HIGH),
    },
    catalog,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "large");
});

test("resolveModel ties on price and size by picking larger context", () => {
  const catalog = {
    default: "short",
    models: [
      {
        id: "short",
        specializations: ["chat"],
        execution_modes: ["direct"],
        tier: "local_strong",
        params_in_billions: 4,
        context_window: 128_000,
      },
      {
        id: "long",
        specializations: ["chat"],
        execution_modes: ["direct"],
        tier: "local_strong",
        params_in_billions: 4,
        context_window: 200_000,
      },
    ],
  };
  const rec = resolveModel(
    {
      model_specialization: specResult("chat", HIGH),
      routing: routingResult("direct", "local_strong", HIGH),
    },
    catalog,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "long");
});

test("resolveModel keeps execution_mode as a hard constraint through relaxation", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", HIGH),
      routing: routingResult("workflow", "local_strong", HIGH),
    },
    {
      default: "direct-coder",
      models: [
        {
          id: "direct-coder",
          specializations: ["coding"],
          execution_modes: ["direct"],
          tier: "local_strong",
          params_in_billions: 14,
          context_window: 128_000,
        },
        {
          id: "workflow-generalist",
          specializations: ["chat"],
          execution_modes: ["workflow"],
          tier: "frontier_fast",
          params_in_billions: 15,
          context_window: 200_000,
          input_tokens_cpm: 0.25,
          cached_tokens_cpm: 0.03,
          output_tokens_cpm: 1.25,
        },
      ],
    },
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "workflow-generalist");
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_used, { execution_mode: "workflow" });
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "specialization", reason: "no_match_relaxed" },
    { axis: "tier", reason: "no_match_relaxed" },
  ]);
});

test("resolveModel falls back to catalog.default when no hard-capability entry matches", () => {
  const rec = resolveModel(
    {
      model_specialization: specResult("coding", HIGH),
      routing: routingResult("workflow", "local_strong", HIGH),
    },
    {
      default: "fallback",
      models: [
        {
          id: "fallback",
          specializations: ["chat"],
          execution_modes: ["direct"],
          tier: "frontier_fast",
          params_in_billions: 15,
          context_window: 200_000,
          input_tokens_cpm: 0.25,
          cached_tokens_cpm: 0.03,
          output_tokens_cpm: 1.25,
        },
      ],
    },
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "fallback");
  assert.equal(rec.resolution.fell_back_to_default, true);
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "specialization", reason: "default_fallback" },
    { axis: "execution_mode", reason: "default_fallback" },
    { axis: "tier", reason: "default_fallback" },
  ]);
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
  assert.equal(envelope.model_recommendation.id, "qwen2.5-coder");
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

test("composeEnvelope picks highest-priority handoff contributor", () => {
  const moduleA = fakeModule("a", [
    {
      slot: "handoff",
      priority: 10,
      build: () => ({ kind: "route", ack_reply: "low priority" }),
    },
  ]);
  const moduleB = fakeModule("b", [
    {
      slot: "handoff",
      priority: 0,
      build: () => ({ kind: "route", ack_reply: "high priority" }),
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
  assert.deepEqual(envelope.handoff, { kind: "route", ack_reply: "high priority" });
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
