// Valid sample outputs for tests + UI demos.

import type { PreflightResult } from "./result.js";

export const VALID_PREFLIGHT_OUTPUT: PreflightResult = {
  terminality: "continue",
  reply: "Let me check.",
  reason: "The latest message requires downstream work.",
  confidence: 0.85,
};
