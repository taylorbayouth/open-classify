import { SECURITY_RISK_LEVEL_VALUES } from "../../enums.js";
import type { ClassifierModule, Contribution } from "../../manifest.js";
import { SECURITY_SYSTEM_PROMPT } from "./prompt.js";
import {
  SECURITY_FALLBACK,
  validateSecurity,
  type SecurityResult,
} from "./result.js";

// Higher than preflight (= 0) so a `terminal` preflight verdict short-
// circuits before the (more expensive) security check.
const SECURITY_PRIORITY = 10;

// Surfaces the safety verdict for downstream UX.
const safetySignalsContribution: Contribution<SecurityResult> = {
  slot: "safety_signals",
  priority: 0,
  build: (result) => ({
    risk_level: result.risk_level,
    signals: [...result.signals],
  }),
};

export const securityModule: ClassifierModule<"security", SecurityResult> = {
  name: "security",
  version: "1.0.0",
  purpose:
    "Assess prompt injection, exfiltration, and permission boundary risk.",
  systemPrompt: SECURITY_SYSTEM_PROMPT,
  validate: validateSecurity,
  fallback: SECURITY_FALLBACK,
  shortCircuit: {
    priority: SECURITY_PRIORITY,
    evaluate: (result) => {
      if (result.risk_level !== "high_risk") return null;
      // No reply — callers detect kind="block" and craft their own refusal.
      return { kind: "block" };
    },
  },
  contributions: [safetySignalsContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-security:v0.1.0",
    },
  },
  ui: {
    label: "Security",
    optionEnum: SECURITY_RISK_LEVEL_VALUES,
    renderer: "object",
  },
};
