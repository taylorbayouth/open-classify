import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CERTAINTY_THRESHOLD,
  composeEnvelope,
  resolveModel,
} from "../dist/src/aggregator.js";

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

const HIGH = "very_strong";
const LOW = "very_weak";

// Construct a fake registry entry. Only `name`, `dispatch_order`, and
// `reservedFields` are read by the aggregator.
function fake(name, dispatch_order, reservedFields = []) {
  return { name, dispatch_order, reservedFields };
}

test("resolveModel picks the cheapest exact routing match", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", certainty: HIGH },
      model_specialization: { model_specialization: "coding", certainty: HIGH },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.3-codex");
  assert.deepEqual(rec.resolution.constraints_used, {
    model_specialization: "coding",
    model_tier: "frontier_fast",
  });
});

test("resolveModel ignores low-certainty routing constraints", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", certainty: LOW },
      model_specialization: { model_specialization: "coding", certainty: LOW },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "qwen2.5-coder");
  assert.deepEqual(rec.resolution.constraints_used, {});
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "model_tier", reason: "low_confidence" },
    { axis: "model_specialization", reason: "low_confidence" },
  ]);
});

test("resolveModel relaxes tier before specialization", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "local_fast", certainty: HIGH },
      model_specialization: { model_specialization: "reasoning", certainty: HIGH },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.4-mini");
  assert.deepEqual(rec.resolution.constraints_used, { model_specialization: "reasoning" });
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "model_tier", reason: "no_match_relaxed" },
  ]);
});

test("resolveModel relaxes specialization and tier when no constraint matches", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "local_strong", certainty: HIGH },
      model_specialization: { model_specialization: "coding", certainty: HIGH },
    },
    {
      default: "fallback",
      models: [
        {
          id: "fallback",
          specializations: ["chat"],
          tier: "frontier_fast",
          params_in_billions: 15,
          context_window: 200_000,
          input_tokens_cpm: 0.25,
          cached_tokens_cpm: 0.03,
          output_tokens_cpm: 1.25,
        },
      ],
    },
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "fallback");
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "model_specialization", reason: "no_match_relaxed" },
    { axis: "model_tier", reason: "no_match_relaxed" },
  ]);
});

test("resolveModel ties on price by picking the larger model", () => {
  const catalog = {
    default: "small",
    models: [
      {
        id: "small",
        specializations: ["chat"],
        tier: "local_strong",
        params_in_billions: 4,
        context_window: 200_000,
      },
      {
        id: "large",
        specializations: ["chat"],
        tier: "local_strong",
        params_in_billions: 14,
        context_window: 128_000,
      },
    ],
  };
  const rec = resolveModel(
    {
      routing: { model_tier: "local_strong", certainty: HIGH },
      model_specialization: { model_specialization: "chat", certainty: HIGH },
    },
    catalog,
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "large");
});

test("composeEnvelope merges reserved fields and lists every classifier output", () => {
  const envelope = composeEnvelope({
    registry: [
      fake("preflight", 10, ["final_reply", "ack_reply"]),
      fake("routing", 20, ["model_tier"]),
      fake("model_specialization", 30, ["model_specialization"]),
      fake("tools", 40, ["tools"]),
      fake("prompt_injection", 50, ["risk_level"]),
      fake("memory", 60, []),
    ],
    results: {
      preflight: { reason: "ack", certainty: "very_strong", ack_reply: { text: "On it." } },
      routing: { reason: "tier", certainty: "very_strong", model_tier: "frontier_fast" },
      model_specialization: { reason: "spec", certainty: "very_strong", model_specialization: "reasoning" },
      tools: { reason: "tools", certainty: "very_strong", tools: ["web", "workspace"] },
      prompt_injection: { reason: "risk", certainty: "very_strong", risk_level: "suspicious" },
      memory: { reason: "a", certainty: "very_strong", queries: ["alpha"] },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  });

  assert.deepEqual(envelope.ack_reply, { text: "On it." });
  assert.equal(envelope.final_reply, undefined);
  assert.deepEqual(envelope.tools, { tools: ["web", "workspace"] });
  assert.deepEqual(envelope.prompt_injection, { risk_level: "suspicious" });
  assert.deepEqual(envelope.routing, {
    model_tier: "frontier_fast",
    model_specialization: "reasoning",
  });
  assert.equal(envelope.classifier_outputs.length, 6);
  assert.equal(envelope.classifier_outputs[0].classifier, "preflight");
  assert.equal(envelope.classifier_outputs[5].classifier, "memory");
  assert.deepEqual(envelope.classifier_outputs[5], {
    classifier: "memory",
    reason: "a",
    certainty: "very_strong",
    queries: ["alpha"],
  });
});

test("composeEnvelope picks highest-certainty contributor when two classifiers share a reserved field", () => {
  const envelope = composeEnvelope({
    registry: [
      fake("routing", 20, ["model_tier"]),
      fake("secondary_router", 25, ["model_tier"]),
    ],
    results: {
      routing: { reason: "weak", certainty: "reasonable", model_tier: "local_fast" },
      secondary_router: { reason: "strong", certainty: "near_certain", model_tier: "frontier_strong" },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  });
  assert.deepEqual(envelope.routing, { model_tier: "frontier_strong" });
});

test("composeEnvelope breaks ties by registry order (first wins)", () => {
  const envelope = composeEnvelope({
    registry: [
      fake("routing", 20, ["model_tier"]),
      fake("secondary_router", 25, ["model_tier"]),
    ],
    results: {
      routing: { reason: "first", certainty: "very_strong", model_tier: "local_fast" },
      secondary_router: { reason: "second", certainty: "very_strong", model_tier: "frontier_strong" },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  });
  assert.deepEqual(envelope.routing, { model_tier: "local_fast" });
});

test("composeEnvelope is pure: same inputs produce structurally equal outputs", () => {
  const args = {
    registry: [fake("tools", 40, ["tools"])],
    results: { tools: { reason: "tools", certainty: "very_strong", tools: [] } },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  };
  assert.deepEqual(composeEnvelope(args), composeEnvelope(args));
});
