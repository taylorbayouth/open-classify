// Verifies the plug-and-play promise of the manifest framework: the
// aggregator, resolver, and per-module short-circuit evaluators all work
// correctly when the registry shape changes (fewer modules, different
// modules, hypothetical-new modules). This is the test-level analog of the
// plan's "drop a module — clean break" verification.
//
// We don't actually delete a module file (that's a git-level operation) —
// instead, we pass a smaller registry into the pure entry points and assert
// that the framework adapts without code changes elsewhere.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeEnvelope } from "../dist/src/aggregator.js";
import { preflightModule } from "../dist/src/classifiers/preflight/module.js";
import { securityModule } from "../dist/src/classifiers/security/module.js";
import { TEST_CATALOG } from "./fixtures.mjs";

function classifierInput(overrides = {}) {
  return {
    text: "hello",
    messages: [{ role: "user", text: "hello" }],
    attachments: [],
    target_message_hash: "deadbeef",
    ...overrides,
  };
}

// ─── 1. Registry can shrink ──────────────────────────────────────────────────

test("composeEnvelope works with a 2-module registry (5 classifiers dropped)", () => {
  const miniRegistry = [preflightModule, securityModule];
  const results = {
    preflight: {
      terminality: "continue",
      reply: "Let me check.",
      reason: "",
      confidence: 0.85,
    },
    security: {
      risk_level: "normal",
      signals: [],
      reason: "",
      confidence: 0.9,
    },
  };

  const envelope = composeEnvelope({
    registry: miniRegistry,
    results,
    catalog: TEST_CATALOG,
    input: classifierInput(),
  });

  // No model_specialization or routing in the registry → resolver sees zero
  // confident signals → biggest model in the catalog wins (per the
  // documented "biggest-on-uncertainty" semantics).
  assert.equal(envelope.model_recommendation.id, "test-frontier-strong");
  assert.deepEqual(envelope.model_recommendation.resolution.constraints_used, {});
  assert.deepEqual(envelope.model_recommendation.resolution.confidences, {});

  // Only preflight + security registered → only their slot contributions
  // appear on the envelope.
  assert.deepEqual(envelope.quick_reply, { text: "Let me check.", kind: "ack" });
  assert.deepEqual(envelope.safety_signals, { risk_level: "normal", signals: [] });
  assert.equal(envelope.memory_queries, undefined);
  assert.equal(envelope.tool_families, undefined);
  assert.equal(envelope.relevant_conversation_history, undefined);
  assert.equal(envelope.requires_full_message_history, undefined);
});

test("composeEnvelope works with a registry of only short-circuiting modules", () => {
  // The route path can still produce a meaningful envelope even if every
  // registered module is a short-circuiter that didn't fire (i.e. all
  // returned "continue"/"normal" on this input).
  const registry = [preflightModule, securityModule];
  const results = {
    preflight: {
      terminality: "continue",
      reply: "On it.",
      reason: "",
      confidence: 0.9,
    },
    security: {
      risk_level: "normal",
      signals: [],
      reason: "",
      confidence: 0.95,
    },
  };

  const envelope = composeEnvelope({
    registry,
    results,
    catalog: TEST_CATALOG,
    input: classifierInput(),
  });

  // Default fallback — biggest in catalog because no confident
  // specialization/routing constraints.
  assert.ok(envelope.model_recommendation.id);
  assert.equal(envelope.quick_reply.text, "On it.");
});

// ─── 2. Short-circuit evaluators are pure + isolated from the pipeline ──────

test("security.shortCircuit.evaluate emits block on high_risk", () => {
  const verdict = securityModule.shortCircuit.evaluate({
    risk_level: "high_risk",
    signals: ["instruction_attack"],
    reason: "Attempts to override instructions.",
    confidence: 0.95,
  });
  assert.deepEqual(verdict, { kind: "block" });
});

test("security.shortCircuit.evaluate returns null on normal risk", () => {
  const verdict = securityModule.shortCircuit.evaluate({
    risk_level: "normal",
    signals: [],
    reason: "",
    confidence: 0.9,
  });
  assert.equal(verdict, null);
});

test("security.shortCircuit.evaluate returns null on suspicious (no block)", () => {
  const verdict = securityModule.shortCircuit.evaluate({
    risk_level: "suspicious",
    signals: ["secret_or_private_data_risk"],
    reason: "API key in message.",
    confidence: 0.7,
  });
  assert.equal(verdict, null);
});

test("preflight.shortCircuit.evaluate emits final on terminality=terminal", () => {
  const verdict = preflightModule.shortCircuit.evaluate({
    terminality: "terminal",
    reply: "Anytime.",
    reason: "",
    confidence: 0.95,
  });
  assert.deepEqual(verdict, { kind: "final", reply: "Anytime." });
});

test("preflight.shortCircuit.evaluate returns null on terminality=continue", () => {
  const verdict = preflightModule.shortCircuit.evaluate({
    terminality: "continue",
    reply: "Let me check.",
    reason: "",
    confidence: 0.85,
  });
  assert.equal(verdict, null);
});

test("preflight.shortCircuit.evaluate returns null on terminality=unable_to_determine", () => {
  // Conservative: never short-circuit when the classifier didn't commit.
  const verdict = preflightModule.shortCircuit.evaluate({
    terminality: "unable_to_determine",
    reply: "Let me check.",
    reason: "",
    confidence: 0.3,
  });
  assert.equal(verdict, null);
});

test("preflight.shortCircuit.evaluate returns null on terminal-with-empty-reply", () => {
  // Defensive: if the model says "terminal" but ships an empty reply, that's
  // not a usable verdict — route normally instead.
  const verdict = preflightModule.shortCircuit.evaluate({
    terminality: "terminal",
    reply: "   ",
    reason: "",
    confidence: 0.9,
  });
  assert.equal(verdict, null);
});

// ─── 3. A hypothetical new module's contributions flow through unchanged ────

test("a synthetic new module's contribution participates in slot merge", () => {
  // Simulates adding a module without editing the framework. The aggregator
  // sees its contribution because contributions are read off the manifest,
  // not from a central registry of slot handlers.
  const fakeSentimentModule = {
    name: "sentiment",
    version: "1.0.0",
    purpose: "Detect sentiment for tone-aware acks.",
    systemPrompt: "",
    validate: () => ({ reason: "", confidence: 0 }),
    fallback: { reason: "", confidence: 0 },
    contributions: [
      {
        slot: "quick_reply",
        // Higher priority (lower number) than preflight's ack at 0... so we
        // use -1 to win the tie deterministically.
        priority: -1,
        build: () => ({ text: "Sounds frustrating — let me dig in.", kind: "ack" }),
      },
    ],
  };

  const registry = [preflightModule, fakeSentimentModule];
  const results = {
    preflight: {
      terminality: "continue",
      reply: "Let me check.",
      reason: "",
      confidence: 0.85,
    },
    sentiment: { reason: "Frustrated tone.", confidence: 0.9 },
  };

  const envelope = composeEnvelope({
    registry,
    results,
    catalog: TEST_CATALOG,
    input: classifierInput(),
  });

  // Higher-priority contributor wins → sentiment's text replaces preflight's
  // generic ack.
  assert.deepEqual(envelope.quick_reply, {
    text: "Sounds frustrating — let me dig in.",
    kind: "ack",
  });
});

test("a synthetic new module that contributes to a fresh slot is preserved verbatim", () => {
  // Validates that any module can claim any slot — the aggregator doesn't
  // know which modules "own" which slots.
  const fakeFormatModule = {
    name: "format_picker",
    version: "1.0.0",
    purpose: "",
    systemPrompt: "",
    validate: () => ({ reason: "", confidence: 0 }),
    fallback: { reason: "", confidence: 0 },
    contributions: [
      {
        slot: "output_format_hint",
        priority: 0,
        build: () => "code",
      },
      {
        slot: "expected_response_length",
        priority: 0,
        build: () => "long",
      },
    ],
  };

  const envelope = composeEnvelope({
    registry: [fakeFormatModule],
    results: { format_picker: { reason: "", confidence: 0.9 } },
    catalog: TEST_CATALOG,
    input: classifierInput(),
  });

  assert.equal(envelope.output_format_hint, "code");
  assert.equal(envelope.expected_response_length, "long");
});

// ─── 4. Removing all short-circuiters: framework still routes ───────────────

test("a registry with zero short-circuiters still produces a route envelope", () => {
  // Conceptually: take preflight (a short-circuiter) and pretend its
  // `shortCircuit` is undefined. The aggregator doesn't care — it only reads
  // contributions, not short-circuit rules.
  const preflightWithoutShortCircuit = {
    ...preflightModule,
    shortCircuit: undefined,
  };

  const envelope = composeEnvelope({
    registry: [preflightWithoutShortCircuit],
    results: {
      preflight: {
        terminality: "terminal",
        reply: "Anytime.",
        reason: "",
        confidence: 0.95,
      },
    },
    catalog: TEST_CATALOG,
    input: classifierInput(),
  });

  // No short-circuit ran (because there's none registered for this run), so
  // preflight's `quick_reply` contribution doesn't fire on "terminal" — it
  // only fires on "continue". Envelope has no quick_reply.
  assert.equal(envelope.quick_reply, undefined);
  // Model recommendation still resolves (catalog default).
  assert.ok(envelope.model_recommendation.id);
});

// ─── 5. mergeOverrides honor caller intent regardless of registry size ──────

test("caller mergeOverrides apply with a 2-module registry", () => {
  const moduleA = {
    name: "a",
    version: "1.0.0",
    purpose: "",
    systemPrompt: "",
    validate: () => ({ reason: "", confidence: 0 }),
    fallback: { reason: "", confidence: 0 },
    contributions: [
      { slot: "memory_queries", priority: 0, build: () => ["first", "second"] },
    ],
  };
  const moduleB = {
    name: "b",
    version: "1.0.0",
    purpose: "",
    systemPrompt: "",
    validate: () => ({ reason: "", confidence: 0 }),
    fallback: { reason: "", confidence: 0 },
    contributions: [
      { slot: "memory_queries", priority: 0, build: () => ["third"] },
    ],
  };

  const envelope = composeEnvelope({
    registry: [moduleA, moduleB],
    results: {
      a: { reason: "", confidence: 0.9 },
      b: { reason: "", confidence: 0.9 },
    },
    catalog: TEST_CATALOG,
    input: classifierInput(),
    config: {
      mergeOverrides: {
        // Override: take only the first contribution, ignoring others.
        memory_queries: (contributions) => contributions[0].value,
      },
    },
  });

  assert.deepEqual(envelope.memory_queries, ["first", "second"]);
});
