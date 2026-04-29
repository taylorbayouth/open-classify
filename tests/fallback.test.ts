import { describe, it, expect } from "vitest";
import { computeRoute } from "../src/route.js";
import { defaultConfig } from "../src/config.js";

describe("fallback behavior", () => {
  it("returns fallback route when classification is null", () => {
    const route = computeRoute(null, defaultConfig);
    expect(route.route).toBe("fallback");
    expect(route.escalated).toBe(false);
    expect(route.escalation_reason).toBeNull();
    expect(route.tools_required).toBe(false);
    expect(route.memory_scope).toBe("none");
  });
});
