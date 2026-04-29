import { describe, it, expect } from "vitest";
import { computeRoute } from "../src/route.js";
import { defaultConfig } from "../src/config.js";
import type { Classification } from "../src/schema.js";

function base(overrides: Partial<Classification> = {}): Classification {
  return {
    task_class: "chat",
    needs_memory: "none",
    tools_required: false,
    suggested_model: "billed_mini",
    security: "clean",
    confidences: {
      task_class: 0.9,
      needs_memory: 0.9,
      tools_required: 0.9,
      suggested_model: 0.9,
      security: 0.9,
    },
    average_confidence: 0.9,
    min_confidence: 0.9,
    ...overrides,
  };
}

describe("computeRoute", () => {
  it("returns fallback when classification is null", () => {
    const r = computeRoute(null, defaultConfig);
    expect(r.route).toBe("fallback");
    expect(r.escalated).toBe(false);
  });

  it("rejects on prompt_injection regardless of other signals", () => {
    const r = computeRoute(base({ security: "prompt_injection" }), defaultConfig);
    expect(r.route).toBe("reject");
    expect(r.escalated).toBe(true);
    expect(r.escalation_reason).toBe("prompt_injection");
    expect(r.requires_confirmation).toBe(true);
  });

  it("escalates to billed_frontier when average confidence is low", () => {
    const r = computeRoute(
      base({ average_confidence: 0.4, suggested_model: "local_fast" }),
      defaultConfig
    );
    expect(r.route).toBe("billed_frontier");
    expect(r.escalation_reason).toBe("low_confidence");
  });

  it("escalates to billed_frontier when min confidence is low", () => {
    const r = computeRoute(
      base({
        average_confidence: 0.85,
        min_confidence: 0.2,
        suggested_model: "local_fast",
      }),
      defaultConfig
    );
    expect(r.route).toBe("billed_frontier");
    expect(r.escalation_reason).toBe("low_confidence");
  });

  it("escalates with confirmation on suspicious security", () => {
    const r = computeRoute(base({ security: "suspicious" }), defaultConfig);
    expect(r.route).toBe("billed_frontier");
    expect(r.requires_confirmation).toBe(true);
    expect(r.escalation_reason).toBe("suspicious");
  });

  it("trusts suggested_model when confidence is high and security is clean", () => {
    const r = computeRoute(base({ suggested_model: "local_fast" }), defaultConfig);
    expect(r.route).toBe("local_fast");
    expect(r.escalated).toBe(false);
  });

  it("propagates tools_required and memory_scope to route decision", () => {
    const r = computeRoute(
      base({ tools_required: true, needs_memory: "long_term" }),
      defaultConfig
    );
    expect(r.tools_required).toBe(true);
    expect(r.memory_scope).toBe("long_term");
  });

  it("prompt_injection takes priority over low confidence", () => {
    const r = computeRoute(
      base({ security: "prompt_injection", average_confidence: 0.3 }),
      defaultConfig
    );
    expect(r.route).toBe("reject");
    expect(r.escalation_reason).toBe("prompt_injection");
  });

  it("low confidence takes priority over suspicious", () => {
    const r = computeRoute(
      base({ security: "suspicious", average_confidence: 0.3 }),
      defaultConfig
    );
    expect(r.route).toBe("billed_frontier");
    expect(r.escalation_reason).toBe("low_confidence");
  });

  it("routes to billed_frontier directly when suggested", () => {
    const r = computeRoute(base({ suggested_model: "billed_frontier" }), defaultConfig);
    expect(r.route).toBe("billed_frontier");
    expect(r.escalated).toBe(false);
  });
});
