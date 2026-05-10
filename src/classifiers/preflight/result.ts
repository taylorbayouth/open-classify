// Result type, validator, and fallback for the preflight classifier. The
// `confidence` field comes from the shared ClassifierResultBase (every
// module's Result extends it).

import {
  ensureExactKeys,
  isRecord,
  requireConfidence,
  requireEnum,
  requireNonEmptyStringMaxLength,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const TERMINALITY_VALUES = [
  "terminal",
  "continue",
  "unable_to_determine",
] as const;
export type Terminality = (typeof TERMINALITY_VALUES)[number];

export const PREFLIGHT_REPLY_MAX_CHARS = 200;
export const PREFLIGHT_REASON_MAX_CHARS = 200;

export interface PreflightResult extends ClassifierResultBase {
  terminality: Terminality;
  reply: string;
}

export function validatePreflight(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): PreflightResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["terminality", "reply", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  const terminality = requireEnum(
    value.terminality,
    TERMINALITY_VALUES,
    ctx.name,
    ctx.model,
    "terminality",
  );
  const reply = requireNonEmptyStringMaxLength(
    value.reply,
    ctx.name,
    ctx.model,
    "reply",
    PREFLIGHT_REPLY_MAX_CHARS,
  );
  const reason = requireStringMaxLength(
    value.reason,
    ctx.name,
    ctx.model,
    "reason",
    PREFLIGHT_REASON_MAX_CHARS,
  );
  const confidence = requireConfidence(value.confidence, ctx.name, ctx.model);
  return { terminality, reply, reason, confidence };
}

// Fallback used when the classifier errors or times out. `confidence: 0`
// guarantees the aggregator drops every threshold-gated signal from this
// classifier; `unable_to_determine` keeps the pipeline routing.
export const PREFLIGHT_FALLBACK: PreflightResult = {
  terminality: "unable_to_determine",
  reply: "",
  reason: "",
  confidence: 0,
};
