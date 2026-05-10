import type { ToolsResult } from "./result.js";

export const VALID_TOOLS_OUTPUT: ToolsResult = {
  needed: true,
  families: ["code"],
  reason: "The request requires code access.",
  confidence: 0.86,
};
