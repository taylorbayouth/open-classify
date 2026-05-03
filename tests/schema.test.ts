import { describe, it, expect } from "vitest";
import {
  AwkResult,
  ResponsePathResult,
  ContextBudgetResult,
  RetrievalNeedResult,
  WorkComplexityResult,
  InputEnvelopeSchema,
} from "../src/schema.js";

describe("AwkResult", () => {
  it("accepts a valid awk", () => {
    expect(
      AwkResult.safeParse({
        text: "Got it.",
        mode: "only",
        should_send: true,
        confidence: 0.95,
      }).success
    ).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(AwkResult.safeParse({ text: "x", mode: "only", should_send: true }).success).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(
      AwkResult.safeParse({ text: "x", mode: "later", should_send: true, confidence: 0.5 }).success
    ).toBe(false);
  });

  it("rejects empty text", () => {
    expect(
      AwkResult.safeParse({ text: "", mode: "only", should_send: true, confidence: 0.5 }).success
    ).toBe(false);
  });

  it("rejects text > 280 chars", () => {
    expect(
      AwkResult.safeParse({
        text: "x".repeat(281),
        mode: "only",
        should_send: true,
        confidence: 0.5,
      }).success
    ).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      AwkResult.safeParse({
        text: "x",
        mode: "only",
        should_send: true,
        confidence: 0.5,
        extra: 1,
      }).success
    ).toBe(false);
  });
});

describe("ResponsePathResult", () => {
  it("validates all 5 values", () => {
    for (const v of ["none", "small_model", "large_model", "tool_assisted", "workflow"]) {
      expect(ResponsePathResult.safeParse({ value: v, confidence: 0.8 }).success).toBe(true);
    }
  });
  it("rejects unknown value", () => {
    expect(ResponsePathResult.safeParse({ value: "frontier", confidence: 0.8 }).success).toBe(false);
  });
  it("rejects out-of-range confidence", () => {
    expect(ResponsePathResult.safeParse({ value: "none", confidence: 1.1 }).success).toBe(false);
  });
});

describe("ContextBudgetResult", () => {
  it("validates all 6 values", () => {
    for (const v of [
      "none",
      "current_message_only",
      "last_exchange",
      "recent_context",
      "retrieved_context_only",
      "full_conversation",
    ]) {
      expect(ContextBudgetResult.safeParse({ value: v, confidence: 0.8 }).success).toBe(true);
    }
  });
  it("rejects unknown value", () => {
    expect(ContextBudgetResult.safeParse({ value: "everything", confidence: 0.8 }).success).toBe(false);
  });
});

describe("RetrievalNeedResult", () => {
  it("accepts a single-item list", () => {
    expect(RetrievalNeedResult.safeParse({ value: ["none"], confidence: 0.9 }).success).toBe(true);
  });

  it("accepts a multi-source list", () => {
    expect(
      RetrievalNeedResult.safeParse({ value: ["web", "files"], confidence: 0.9 }).success
    ).toBe(true);
  });

  it("rejects empty list", () => {
    expect(RetrievalNeedResult.safeParse({ value: [], confidence: 0.9 }).success).toBe(false);
  });

  it("rejects invalid item", () => {
    expect(
      RetrievalNeedResult.safeParse({ value: ["telepathy"], confidence: 0.9 }).success
    ).toBe(false);
  });
});

describe("WorkComplexityResult", () => {
  it("validates all 5 values", () => {
    for (const v of ["trivial", "simple", "moderate", "complex", "multi_step"]) {
      expect(WorkComplexityResult.safeParse({ value: v, confidence: 0.7 }).success).toBe(true);
    }
  });
  it("rejects unknown value", () => {
    expect(WorkComplexityResult.safeParse({ value: "easy", confidence: 0.7 }).success).toBe(false);
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
