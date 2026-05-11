// Result type, validator, and fallback for the security classifier. A
// `high_risk` verdict triggers the module's short-circuit (kind: "block");
// the aggregator's `safety_signals` merger handles non-blocking signals
// from this and any other module that contributes to that slot.

import {
  SECURITY_RISK_LEVEL_VALUES,
  SECURITY_SIGNAL_VALUES,
  type SecurityRiskLevel,
  type SecuritySignal,
} from "../../enums.js";
import {
  ensureExactKeys,
  ensureNoDuplicates,
  isRecord,
  requireConfidence,
  requireEnum,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const SECURITY_REASON_MAX_CHARS = 200;

export interface SecurityResult extends ClassifierResultBase {
  risk_level: SecurityRiskLevel;
  signals: SecuritySignal[];
}

export function validateSecurity(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): SecurityResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["risk_level", "signals", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  if (!Array.isArray(value.signals)) {
    throwInvalid(ctx.name, ctx.model, "signals must be an array");
  }

  const riskLevel = requireEnum(
    value.risk_level,
    SECURITY_RISK_LEVEL_VALUES,
    ctx.name,
    ctx.model,
    "risk_level",
  );
  const signals = value.signals.map((item, index) =>
    requireEnum(item, SECURITY_SIGNAL_VALUES, ctx.name, ctx.model, `signals[${index}]`),
  );
  ensureNoDuplicates(signals, ctx.name, ctx.model, "signals");

  if ((riskLevel === "normal" || riskLevel === "unable_to_determine") && signals.length > 0) {
    throwInvalid(ctx.name, ctx.model, `${riskLevel} risk_level must not include signals`);
  }
  if (riskLevel !== "normal" && riskLevel !== "unable_to_determine" && signals.length === 0) {
    throwInvalid(ctx.name, ctx.model, "elevated risk_level must include at least one signal");
  }

  return {
    risk_level: riskLevel,
    signals,
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      SECURITY_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

// Fallback uses `unable_to_determine` so the short-circuit's guard
// (only block on a real model verdict) treats it as a non-block. Confidence
// 0 makes the aggregator drop the verdict from safety_signals merges.
export const SECURITY_FALLBACK: SecurityResult = {
  risk_level: "unable_to_determine",
  signals: [],
  reason: "",
  confidence: 0,
};
