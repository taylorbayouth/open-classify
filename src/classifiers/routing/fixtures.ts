import type { RoutingResult } from "./result.js";

export const VALID_ROUTING_OUTPUT: RoutingResult = {
  execution_mode: "tool_assisted",
  model_tier: "local_strong",
  reason: "The request needs tools and moderate reasoning.",
  confidence: 0.82,
};
