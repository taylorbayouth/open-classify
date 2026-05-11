// Security classifier module. Two roles:
//   - Short-circuits the pipeline with `kind: "block"` when the model
//     verdict is `high_risk` AND confidence is real (the fallback's
//     `unable_to_determine` never blocks).
//   - Contributes to the `safety_signals` envelope slot on the route path,
//     so suspicious-but-not-blocking verdicts still surface downstream.

import { SECURITY_RISK_LEVEL_VALUES, SECURITY_SIGNAL_VALUES } from "../../enums.js";
import type { ClassifierModule, Contribution } from "../../manifest.js";
import { SECURITY_SYSTEM_PROMPT } from "./prompt.js";
import { SECURITY_FALLBACK, validateSecurity, type SecurityResult } from "./result.js";

// Preflight = 0 (runs first), security = 10. Order matters: a terminal
// preflight should preempt a security block when both would fire.
const SECURITY_PRIORITY = 10;

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
  purpose: "Assess prompt injection, exfiltration, and permission boundary risk.",
  systemPrompt: SECURITY_SYSTEM_PROMPT,
  validate: validateSecurity,
  fallback: SECURITY_FALLBACK,
  shortCircuit: {
    priority: SECURITY_PRIORITY,
    evaluate: (result) => {
      if (result.risk_level !== "high_risk") return null;
      // Guard against fallback masquerading as a verdict — fallbacks emit
      // confidence: 0, real verdicts at high_risk should be confident.
      if (result.confidence <= 0) return null;
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
    optionEnum: [...SECURITY_RISK_LEVEL_VALUES, ...SECURITY_SIGNAL_VALUES],
    renderer: "object",
  },
};
