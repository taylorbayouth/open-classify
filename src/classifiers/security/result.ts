import {
  SECURITY_RISK_LEVEL_VALUES,
  SECURITY_SIGNAL_VALUES,
  type SecurityRiskLevel,
  type SecuritySignal,
} from "../../enums.js";
import type {
  ClassifierResultBase,
  ClassifierValidationContext,
} from "../../manifest.js";
import {
  ensureExactKeys,
  ensureNoDuplicates,
  isRecord,
  requireConfidence,
  requireEnum,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";

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

  if (
    (riskLevel === "normal" || riskLevel === "unable_to_determine") &&
    signals.length > 0
  ) {
    throwInvalid(
      ctx.name,
      ctx.model,
      `${riskLevel} risk_level must not include signals`,
    );
  }
  if (
    riskLevel !== "normal" &&
    riskLevel !== "unable_to_determine" &&
    signals.length === 0
  ) {
    throwInvalid(
      ctx.name,
      ctx.model,
      "elevated risk_level must include at least one signal",
    );
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

export const SECURITY_FALLBACK: SecurityResult = {
  risk_level: "unable_to_determine",
  signals: [],
  reason: "",
  confidence: 0,
};
