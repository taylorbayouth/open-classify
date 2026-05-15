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

test("resolveModel picks the cheapest exact stock-routing match", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", certainty: HIGH },
      model_specialization: { specialization: "coding", certainty: HIGH },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.3-codex");
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "coding",
    tier: "frontier_fast",
  });
});

test("resolveModel ignores low-certainty stock routing", () => {
  const rec = resolveModel(
    {
      routing: { model_tier: "frontier_fast", certainty: LOW },
      model_specialization: { specialization: "coding", certainty: LOW },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
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
      routing: { model_tier: "local_fast", certainty: HIGH },
      model_specialization: { specialization: "reasoning", certainty: HIGH },
    },
    CATALOG,
    DEFAULT_CERTAINTY_THRESHOLD,
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
      routing: { model_tier: "local_strong", certainty: HIGH },
      model_specialization: { specialization: "coding", certainty: HIGH },
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
      routing: { model_tier: "local_strong", certainty: HIGH },
      model_specialization: { specialization: "chat", certainty: HIGH },
    },
    catalog,
    DEFAULT_CERTAINTY_THRESHOLD,
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
      { kind: "stock", name: "prompt_injection", order: 50 },
      { kind: "custom", name: "memory", order: 60 },
    ],
    results: {
      preflight: { ack_reply: { text: "On it." }, certainty: "very_strong" },
      routing: { model_tier: "frontier_fast", certainty: "very_strong" },
      model_specialization: { specialization: "reasoning", certainty: "very_strong" },
      tools: { tools: ["web", "workspace"], certainty: "very_strong" },
      prompt_injection: { risk_level: "suspicious", certainty: "very_strong" },
      memory: { output: { queries: ["alpha"] }, reason: "a", certainty: "very_strong" },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  });

  assert.deepEqual(envelope.ack_reply, { text: "On it." });
  assert.equal(envelope.final_reply, undefined);
  assert.deepEqual(envelope.tools, { tools: ["web", "workspace"] });
  assert.deepEqual(envelope.prompt_injection, {
    risk_level: "suspicious",
  });
  assert.deepEqual(envelope.routing, {
    model_tier: "frontier_fast",
    specialization: "reasoning",
  });
  assert.deepEqual(envelope.custom_outputs, [
    { classifier: "memory", reason: "a", certainty: "very_strong", output: { queries: ["alpha"] } },
  ]);
});

test("composeEnvelope is pure: same inputs produce structurally equal outputs", () => {
  const args = {
    registry: [{ kind: "stock", name: "tools", order: 40 }],
    results: { tools: { tools: [], certainty: "very_strong" } },
    catalog: CATALOG,
    input: { text: "x", messages: [], target_message_hash: "abc12345" },
  };
  assert.deepEqual(composeEnvelope(args), composeEnvelope(args));
});
