import { describe, it, expect } from "vitest";
import { computeRoute } from "../src/route.js";
import { defaultConfig } from "../src/config.js";

describe("fallback route", () => {
  it("returns fallback route when classification is null", () => {
    const route = computeRoute(null, defaultConfig);
    expect(route.route).toBe("fallback");
    expect(route.model_tier).toBe(defaultConfig.routing.default_model_tier);
    expect(typeof route.requires_confirmation).toBe("boolean");
    expect(typeof route.requires_web).toBe("boolean");
    expect(typeof route.requires_private_context).toBe("boolean");
  });
});
