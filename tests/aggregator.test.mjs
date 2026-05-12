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

const HIGH = 0.9;
const LOW = 0.1;

test("resolveModel picks the cheapest exact stock-routing match", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", confidence: HIGH },
      model_specialization: { specialization: "coding", confidence: HIGH },
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.3-codex");
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "coding",
    tier: "frontier_fast",
  });
});

test("resolveModel ignores low-confidence stock routing", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", confidence: LOW },
      model_specialization: { specialization: "coding", confidence: LOW },
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  // No confident constraints → catalog default ranking → cheapest model.
  assert.equal(rec.id, "qwen2.5-coder");
  assert.deepEqual(rec.resolution.constraints_used, {});
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "specialization", reason: "low_confidence" },
    { axis: "tier", reason: "low_confidence" },
  ]);
});

test("resolveModel relaxes tier before specialization", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "local_fast", confidence: HIGH },
      model_specialization: { specialization: "reasoning", confidence: HIGH },
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.4-mini");
  assert.deepEqual(rec.resolution.constraints_used, { specialization: "reasoning" });
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "tier", reason: "no_match_relaxed" },
  ]);
});

test("resolveModel relaxes specialization and tier when no constraint matches", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "local_strong", confidence: HIGH },
      model_specialization: { specialization: "coding", confidence: HIGH },
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
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "fallback");
  assert.equal(rec.resolution.fell_back_to_default, false);
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "specialization", reason: "no_match_relaxed" },
    { axis: "tier", reason: "no_match_relaxed" },
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
      routing: { model_tier: "local_strong", confidence: HIGH },
      model_specialization: { specialization: "chat", confidence: HIGH },
    },
    catalog,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "large");
});

test("composeEnvelope merges stock fields and custom outputs", () => {
  const envelope = composeEnvelope({
    registry: [
      { kind: "stock", name: "preflight", order: 10 },
      { kind: "stock", name: "routing", order: 20 },
      { kind: "stock", name: "model_specialization", order: 30 },
      { kind: "stock", name: "tools", order: 40 },
      { kind: "stock", name: "security", order: 50 },
      { kind: "custom", name: "memory", order: 60 },
    ],
    results: {
      preflight: { ack_reply: { reply: "On it." }, confidence: 0.9 },
      routing: { model_tier: "frontier_fast", confidence: 0.9 },
      model_specialization: { specialization: "reasoning", confidence: 0.9 },
      tools: { required: true, families: ["web", "workspace"], confidence: 0.9 },
      security: { risk_level: "suspicious", signals: ["instruction_attack"], confidence: 0.9 },
      memory: { output: { queries: ["alpha"] }, reason: "a", confidence: 0.9 },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  });

  assert.deepEqual(envelope.ack_reply, { reply: "On it." });
  assert.equal(envelope.final_reply, undefined);
  assert.deepEqual(envelope.tools, { required: true, families: ["web", "workspace"] });
  assert.deepEqual(envelope.safety, {
    risk_level: "suspicious",
    signals: ["instruction_attack"],
  });
  assert.deepEqual(envelope.routing, {
    model_tier: "frontier_fast",
    specialization: "reasoning",
  });
  assert.deepEqual(envelope.custom_outputs, [
    { classifier: "memory", reason: "a", confidence: 0.9, output: { queries: ["alpha"] } },
  ]);
});

test("composeEnvelope is pure: same inputs produce structurally equal outputs", () => {
  const args = {
    registry: [{ kind: "stock", name: "tools", order: 40 }],
    results: { tools: { required: false, families: [], confidence: 0.9 } },
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  };
  assert.deepEqual(composeEnvelope(args), composeEnvelope(args));
});
