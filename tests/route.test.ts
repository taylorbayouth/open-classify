import { describe, it, expect } from "vitest";
import { computeRoute } from "../src/route.js";
import { defaultConfig } from "../src/config.js";
import type { Classification } from "../src/schema.js";

function base(overrides: Partial<Classification> = {}): Classification {
  return {
    task_class: "chat",
    needs_fresh_info: false,
    needs_private_context: false,
    needs_side_effect_tool: false,
    risk: "low",
    confidence: 0.9,
    reason: "test",
    ...overrides,
  };
}

describe("computeRoute", () => {
  it("returns fallback when classification is null", () => {
    const r = computeRoute(null, defaultConfig);
    expect(r.route).toBe("fallback");
    expect(r.requires_confirmation).toBe(false);
  });

  it("routes side-effect requests to confirm_side_effect", () => {
    const r = computeRoute(base({ needs_side_effect_tool: true }), defaultConfig);
    expect(r.route).toBe("confirm_side_effect");
    expect(r.requires_confirmation).toBe(true);
  });

  it("uses frontier tier for high-risk side effects", () => {
    const r = computeRoute(
      base({ needs_side_effect_tool: true, risk: "high" }),
      defaultConfig
    );
    expect(r.route).toBe("confirm_side_effect");
    expect(r.model_tier).toBe("frontier");
  });

  it("routes high-risk non-side-effect to frontier with confirmation", () => {
    const r = computeRoute(base({ risk: "high" }), defaultConfig);
    expect(r.route).toBe("frontier");
    expect(r.requires_confirmation).toBe(true);
    expect(r.model_tier).toBe("frontier");
  });

  it("routes fresh-info requests to web", () => {
    const r = computeRoute(base({ needs_fresh_info: true }), defaultConfig);
    expect(r.route).toBe("web");
    expect(r.requires_web).toBe(true);
  });

  it("routes private-context requests to private_context", () => {
    const r = computeRoute(base({ needs_private_context: true }), defaultConfig);
    expect(r.route).toBe("private_context");
    expect(r.requires_private_context).toBe(true);
  });

  it("routes code tasks to cheap", () => {
    const r = computeRoute(base({ task_class: "code" }), defaultConfig);
    expect(r.route).toBe("cheap");
    expect(r.model_tier).toBe(defaultConfig.routing.code_model_tier);
  });

  it("routes research tasks to frontier", () => {
    const r = computeRoute(base({ task_class: "research" }), defaultConfig);
    expect(r.route).toBe("frontier");
    expect(r.model_tier).toBe(defaultConfig.routing.research_model_tier);
  });

  it("side_effect takes priority over fresh_info", () => {
    const r = computeRoute(
      base({ needs_side_effect_tool: true, needs_fresh_info: true }),
      defaultConfig
    );
    expect(r.route).toBe("confirm_side_effect");
    expect(r.requires_web).toBe(true); // still propagates
  });

  it("routes chat to cheap by default", () => {
    const r = computeRoute(base({ task_class: "chat" }), defaultConfig);
    expect(r.route).toBe("cheap");
    expect(r.requires_confirmation).toBe(false);
    expect(r.requires_web).toBe(false);
  });
});
