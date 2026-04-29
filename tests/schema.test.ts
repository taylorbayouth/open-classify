import { describe, it, expect } from "vitest";
import {
  ClassificationSchema,
  InputEnvelopeSchema,
  RouteDecisionSchema,
  TaskClassResult,
  MemoryResult,
  ToolsResult,
  ModelResult,
  SecurityResult,
} from "../src/schema.js";

describe("Per-classifier result schemas", () => {
  it("TaskClassResult validates correctly", () => {
    expect(TaskClassResult.safeParse({ task_class: "code", confidence: 0.9 }).success).toBe(true);
    expect(TaskClassResult.safeParse({ task_class: "writing", confidence: 0.9 }).success).toBe(false);
    expect(TaskClassResult.safeParse({ task_class: "code", confidence: 1.5 }).success).toBe(false);
    expect(TaskClassResult.safeParse({ task_class: "code", confidence: 0.9, extra: 1 }).success).toBe(false);
  });

  it("MemoryResult validates the four memory levels", () => {
    expect(MemoryResult.safeParse({ needs_memory: "none", confidence: 0.9 }).success).toBe(true);
    expect(MemoryResult.safeParse({ needs_memory: "recent", confidence: 0.9 }).success).toBe(true);
    expect(MemoryResult.safeParse({ needs_memory: "session", confidence: 0.9 }).success).toBe(true);
    expect(MemoryResult.safeParse({ needs_memory: "long_term", confidence: 0.9 }).success).toBe(true);
    expect(MemoryResult.safeParse({ needs_memory: "forever", confidence: 0.9 }).success).toBe(false);
  });

  it("ToolsResult requires boolean", () => {
    expect(ToolsResult.safeParse({ tools_required: true, confidence: 0.9 }).success).toBe(true);
    expect(ToolsResult.safeParse({ tools_required: "yes", confidence: 0.9 }).success).toBe(false);
  });

  it("ModelResult validates model tiers", () => {
    for (const tier of ["local_fast", "local_slow", "billed_mini", "billed_frontier"]) {
      expect(ModelResult.safeParse({ suggested_model: tier, confidence: 0.9 }).success).toBe(true);
    }
    expect(ModelResult.safeParse({ suggested_model: "frontier", confidence: 0.9 }).success).toBe(false);
  });

  it("SecurityResult validates security levels", () => {
    expect(SecurityResult.safeParse({ security: "clean", confidence: 0.9 }).success).toBe(true);
    expect(SecurityResult.safeParse({ security: "suspicious", confidence: 0.9 }).success).toBe(true);
    expect(SecurityResult.safeParse({ security: "prompt_injection", confidence: 0.9 }).success).toBe(true);
    expect(SecurityResult.safeParse({ security: "injected", confidence: 0.9 }).success).toBe(false);
  });
});

describe("Aggregated ClassificationSchema", () => {
  const valid = {
    task_class: "code",
    needs_memory: "recent",
    tools_required: false,
    suggested_model: "billed_mini",
    security: "clean",
    confidences: {
      task_class: 0.9,
      needs_memory: 0.7,
      tools_required: 0.95,
      suggested_model: 0.6,
      security: 0.99,
    },
    average_confidence: 0.83,
    min_confidence: 0.6,
  };

  it("accepts valid aggregated classification", () => {
    expect(ClassificationSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects when confidences object is missing fields", () => {
    const bad = { ...valid, confidences: { task_class: 0.9 } };
    expect(ClassificationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when average_confidence is out of range", () => {
    expect(ClassificationSchema.safeParse({ ...valid, average_confidence: 1.5 }).success).toBe(false);
  });
});

describe("InputEnvelopeSchema", () => {
  it("accepts minimal valid envelope", () => {
    expect(InputEnvelopeSchema.safeParse({ request_id: "abc", user_input: "hi" }).success).toBe(true);
  });
  it("requires both fields", () => {
    expect(InputEnvelopeSchema.safeParse({ user_input: "hi" }).success).toBe(false);
    expect(InputEnvelopeSchema.safeParse({ request_id: "abc" }).success).toBe(false);
  });
});

describe("RouteDecisionSchema", () => {
  it("accepts a valid route decision", () => {
    const r = {
      route: "billed_mini",
      requires_confirmation: false,
      tools_required: false,
      memory_scope: "none",
      escalated: false,
      escalation_reason: null,
    };
    expect(RouteDecisionSchema.safeParse(r).success).toBe(true);
  });
});
