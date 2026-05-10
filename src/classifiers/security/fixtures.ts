import type { SecurityResult } from "./result.js";

export const VALID_SECURITY_OUTPUT: SecurityResult = {
  risk_level: "normal",
  signals: [],
  reason: "No notable risk.",
  confidence: 0.92,
};
