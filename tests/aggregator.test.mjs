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

function routingSignal(routing, confidence = HIGH) {
  return { routing, reason: "ok", confidence };
}

test("resolveModel picks the cheapest exact stock-routing match", () => {
  const rec = resolveModel(
    {
      routing: routingSignal({
        specialization: "coding",
        execution_mode: "tool_assisted",
        model_tier: "frontier_fast",
      }),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.3-codex");
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "coding",
    execution_mode: "tool_assisted",
    tier: "frontier_fast",
  });
});

test("resolveModel ignores low-confidence stock routing", () => {
  const rec = resolveModel(
    {
      routing: routingSignal({
        specialization: "coding",
        execution_mode: "tool_assisted",
        model_tier: "frontier_fast",
      }, LOW),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "qwen2.5-coder");
  assert.deepEqual(rec.resolution.constraints_used, {});
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "specialization", reason: "low_confidence" },
    { axis: "execution_mode", reason: "low_confidence" },
    { axis: "tier", reason: "low_confidence" },
  ]);
});

test("resolveModel relaxes tier before specialization", () => {
  const rec = resolveModel(
    {
      routing: routingSignal({
        specialization: "reasoning",
        execution_mode: "workflow",
        model_tier: "local_fast",
      }),
    },
    CATALOG,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "gpt-5.4-mini");
  assert.deepEqual(rec.resolution.constraints_used, {
    specialization: "reasoning",
    execution_mode: "workflow",
  });
  assert.deepEqual(rec.resolution.constraints_dropped, [
    { axis: "tier", reason: "no_match_relaxed" },
  ]);
});

test("resolveModel keeps execution_mode as a hard constraint through relaxation", () => {
  const rec = resolveModel(
    {
      routing: routingSignal({
        specialization: "coding",
        execution_mode: "workflow",
        model_tier: "local_strong",
      }),
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
  assert.deepEqual(rec.resolution.constraints_used, { execution_mode: "workflow" });
});

test("resolveModel falls back to catalog.default when no hard-capability entry matches", () => {
  const rec = resolveModel(
    {
      routing: routingSignal({
        specialization: "coding",
        execution_mode: "workflow",
        model_tier: "local_strong",
      }),
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
      routing: routingSignal({
        specialization: "chat",
        execution_mode: "direct",
        model_tier: "local_strong",
      }),
    },
    catalog,
    DEFAULT_CONFIDENCE_THRESHOLD,
  );
  assert.equal(rec.id, "large");
});

test("composeEnvelope merges stock fields and custom outputs", () => {
  const envelope = composeEnvelope({
    registry: [
      { name: "a", order: 20 },
      { name: "b", order: 10 },
      { name: "c", order: 30 },
    ],
    results: {
      a: {
        reason: "a",
        confidence: 0.9,
        handoff: { kind: "route", ack_reply: "low priority" },
        tools: { required: true, families: ["workspace"] },
        output: { queries: ["alpha"] },
      },
      b: {
        reason: "b",
        confidence: 0.9,
        handoff: { kind: "route", ack_reply: "high priority" },
        tools: { required: true, families: ["web", "workspace"] },
        routing: {
          specialization: "reasoning",
          execution_mode: "tool_assisted",
          model_tier: "frontier_fast",
        },
      },
      c: {
        reason: "c",
        confidence: 0.9,
        safety: { risk_level: "suspicious", signals: ["instruction_attack"] },
      },
    },
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  });

  assert.deepEqual(envelope.handoff, { kind: "route", ack_reply: "high priority" });
  assert.deepEqual(envelope.tools, { required: true, families: ["workspace", "web"] });
  assert.deepEqual(envelope.safety, {
    risk_level: "suspicious",
    signals: ["instruction_attack"],
  });
  assert.deepEqual(envelope.custom_outputs, [
    { classifier: "a", reason: "a", confidence: 0.9, output: { queries: ["alpha"] } },
  ]);
  assert.equal(envelope.memory_queries, undefined);
  assert.equal(envelope.tool_families, undefined);
  assert.equal(envelope.safety_signals, undefined);
});

test("composeEnvelope is pure: same inputs produce structurally equal outputs", () => {
  const args = {
    registry: [{ name: "a", order: 0 }],
    results: { a: { reason: "", confidence: 0.9, tools: { required: false, families: [] } } },
    catalog: CATALOG,
    input: { text: "x", messages: [], attachments: [], target_message_hash: "abc12345" },
  };
  assert.deepEqual(composeEnvelope(args), composeEnvelope(args));
});
