import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStockClassifierPrompt,
  validateJsonClassifierManifest,
  validateStockClassifierOutput,
} from "../dist/src/index.js";

test("validates a config-driven manifest with stock fields", () => {
  const manifest = validateJsonClassifierManifest({
    name: "conversation_context",
    version: "1.0.0",
    purpose: "Decide how much visible conversation history the downstream model needs.",
    order: 10,
    emits: {
      context: true,
      summary: true,
      response: true,
    },
    fallback: {
      reason: "",
      confidence: 0,
      context: { status: "unknown" },
    },
  });

  assert.equal(manifest.name, "conversation_context");
  assert.deepEqual(manifest.fallback.context, { status: "unknown" });
  assert.equal(manifest.emits.context, true);
});

test("rejects undeclared stock output fields", () => {
  assert.throws(
    () =>
      validateStockClassifierOutput(
        {
          reason: "ok",
          confidence: 0.9,
          safety: { risk_level: "normal", signals: [] },
        },
        {
          classifier: "context",
          model: "test",
          emits: { context: true },
        },
      ),
    /safety is not declared in emits/,
  );
});

test("validates context as a discriminated union", () => {
  assert.deepEqual(
    validateStockClassifierOutput(
      {
        reason: "The target refers to the previous answer.",
        confidence: 0.91,
        context: { status: "sufficient", include_prior_messages: 2 },
      },
      {
        classifier: "context",
        model: "test",
        emits: { context: true },
      },
    ).context,
    { status: "sufficient", include_prior_messages: 2 },
  );

  assert.throws(
    () =>
      validateStockClassifierOutput(
        {
          reason: "bad",
          confidence: 0.9,
          context: { status: "insufficient", include_prior_messages: 2 },
        },
        {
          classifier: "context",
          model: "test",
          emits: { context: true },
        },
      ),
    /include_prior_messages is only valid/,
  );
});

test("validates configurable tool families", () => {
  const options = {
    classifier: "tools",
    model: "test",
    emits: { tools: true },
    toolFamilies: ["repo", "calendar"],
  };

  assert.deepEqual(
    validateStockClassifierOutput(
      {
        reason: "Needs repository access.",
        confidence: 0.88,
        tools: { required: true, families: ["repo"] },
      },
      options,
    ).tools,
    { required: true, families: ["repo"] },
  );

  assert.throws(
    () =>
      validateStockClassifierOutput(
        {
          reason: "Needs mail.",
          confidence: 0.88,
          tools: { required: true, families: ["email"] },
        },
        options,
      ),
    /unsupported family email/,
  );
});

test("builds stock prompt fragments from manifest emits", () => {
  const manifest = validateJsonClassifierManifest({
    name: "tool_router",
    version: "1.0.0",
    purpose: "Pick tool access for the downstream model.",
    order: 10,
    emits: { tools: true, handoff: true },
    tool_families: [
      { id: "repo", description: "Read and edit source repositories." },
    ],
    fallback: {
      reason: "",
      confidence: 0,
      tools: { required: false, families: [] },
    },
  });

  const prompt = buildStockClassifierPrompt(manifest);
  assert.match(prompt, /Return one JSON object/);
  assert.match(prompt, /handoff:/);
  assert.match(prompt, /tools:/);
  assert.match(prompt, /repo: Read and edit source repositories/);
  assert.doesNotMatch(prompt, /context:/);
});

test("requires output_schema when emitting custom output", () => {
  assert.throws(
    () =>
      validateJsonClassifierManifest({
        name: "memory",
        version: "1.0.0",
        purpose: "Emit memory queries.",
        order: 20,
        emits: { output: true },
        fallback: { reason: "", confidence: 0, output: { queries: [] } },
      }),
    /output_schema is required/,
  );
});

test("validates custom output with JSON Schema", () => {
  const options = {
    classifier: "memory",
    model: "test",
    emits: { output: true },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
  };

  assert.deepEqual(
    validateStockClassifierOutput(
      {
        reason: "Memory may help.",
        confidence: 0.8,
        output: { queries: ["review preferences"] },
      },
      options,
    ).output,
    { queries: ["review preferences"] },
  );

  assert.throws(
    () =>
      validateStockClassifierOutput(
        {
          reason: "bad",
          confidence: 0.8,
          output: { queries: [""] },
        },
        options,
      ),
    /must NOT have fewer than 1 characters/,
  );
});
