import { describe, it, expect } from "vitest";
import { ClassificationSchema, InputEnvelopeSchema, RouteDecisionSchema } from "../src/schema.js";

describe("ClassificationSchema", () => {
  const valid = {
    task_class: "code",
    needs_fresh_info: false,
    needs_private_context: false,
    needs_side_effect_tool: false,
    risk: "medium",
    confidence: 0.82,
    reason: "User asks for code debugging.",
  };

  it("accepts a valid classification", () => {
    expect(ClassificationSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = ClassificationSchema.safeParse({ ...valid, extra: "field" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid task_class enum", () => {
    const result = ClassificationSchema.safeParse({ ...valid, task_class: "agent" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence out of range", () => {
    expect(ClassificationSchema.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
    expect(ClassificationSchema.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects reason over 160 chars", () => {
    const result = ClassificationSchema.safeParse({ ...valid, reason: "x".repeat(161) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid risk enum", () => {
    const result = ClassificationSchema.safeParse({ ...valid, risk: "critical" });
    expect(result.success).toBe(false);
  });

  it("accepts confidence at boundary values 0 and 1", () => {
    expect(ClassificationSchema.safeParse({ ...valid, confidence: 0 }).success).toBe(true);
    expect(ClassificationSchema.safeParse({ ...valid, confidence: 1 }).success).toBe(true);
  });
});

describe("InputEnvelopeSchema", () => {
  it("accepts minimal valid envelope", () => {
    const result = InputEnvelopeSchema.safeParse({ request_id: "abc", user_input: "hello" });
    expect(result.success).toBe(true);
  });

  it("requires request_id and user_input", () => {
    expect(InputEnvelopeSchema.safeParse({ user_input: "hello" }).success).toBe(false);
    expect(InputEnvelopeSchema.safeParse({ request_id: "abc" }).success).toBe(false);
  });

  it("accepts optional fields", () => {
    const result = InputEnvelopeSchema.safeParse({
      request_id: "abc",
      user_input: "hello",
      state_capsule: { foo: "bar" },
      metadata: { source: "cli" },
    });
    expect(result.success).toBe(true);
  });
});
