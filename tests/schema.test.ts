import { describe, it, expect } from "vitest";
import { CLASSIFIERS } from "../src/classifiers.js";
import { InputEnvelopeSchema, sanitizeUserInput } from "../src/schema.js";

const AwkResult = CLASSIFIERS.awk.schema;
const ResponsePathResult = CLASSIFIERS.response_path.schema;
const ContextBudgetResult = CLASSIFIERS.context_budget.schema;
const RetrievalNeedResult = CLASSIFIERS.retrieval_need.schema;
const WorkComplexityResult = CLASSIFIERS.work_complexity.schema;

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
  it("trims user_input", () => {
    const parsed = InputEnvelopeSchema.parse({ request_id: "x", user_input: "  hello  " });
    expect(parsed.user_input).toBe("hello");
  });
  it("rejects whitespace-only input", () => {
    expect(InputEnvelopeSchema.safeParse({ request_id: "x", user_input: "   " }).success).toBe(false);
  });
  it("imposes no upper length bound at the schema level", () => {
    // The library does not decide how long an input may be. Operators who
    // care set `server.max_body_bytes` at the HTTP layer instead.
    const huge = "x".repeat(5_000_000);
    expect(InputEnvelopeSchema.safeParse({ request_id: "x", user_input: huge }).success).toBe(true);
  });
});

describe("sanitizeUserInput", () => {
  it("strips a leading BOM", () => {
    expect(sanitizeUserInput("﻿hello")).toBe("hello");
  });
  it("does not strip a non-leading BOM", () => {
    expect(sanitizeUserInput("hi﻿there")).toBe("hi﻿there");
  });
  it("normalizes to NFC (composed and decomposed forms collapse)", () => {
    const composed = "café"; // café (single codepoint)
    const decomposed = "café"; // café (e + combining acute)
    expect(sanitizeUserInput(composed)).toBe(sanitizeUserInput(decomposed));
  });
  it("strips NUL and other ASCII control chars", () => {
    expect(sanitizeUserInput("hi\x00the\x07re")).toBe("hithere");
  });
  it("preserves \\t, \\n, \\r", () => {
    expect(sanitizeUserInput("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });
  it("trims outer whitespace", () => {
    expect(sanitizeUserInput("   hi   ")).toBe("hi");
  });
  it("is idempotent", () => {
    const samples = [
      "﻿  café \x00 \n",
      "plain",
      "  \t spaced \r\n  ",
      "café — naïve — résumé",
      "",
    ];
    for (const s of samples) {
      const once = sanitizeUserInput(s);
      expect(sanitizeUserInput(once)).toBe(once);
    }
  });
});
