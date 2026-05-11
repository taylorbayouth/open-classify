// Result type, validator, and fallback for the model_specialization
// classifier. Like routing, this feeds the aggregator's resolver via the
// per-classifier results map — no envelope-slot contributions of its own.

import {
  MODEL_SPECIALIZATION_VALUES,
  type ModelSpecialization,
} from "../../enums.js";
import {
  ensureExactKeys,
  isRecord,
  requireConfidence,
  requireEnum,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const MODEL_SPECIALIZATION_REASON_MAX_CHARS = 200;

export interface ModelSpecializationResult extends ClassifierResultBase {
  model_specialization: ModelSpecialization;
}

export function validateModelSpecialization(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): ModelSpecializationResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["model_specialization", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  return {
    model_specialization: requireEnum(
      value.model_specialization,
      MODEL_SPECIALIZATION_VALUES,
      ctx.name,
      ctx.model,
      "model_specialization",
    ),
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      MODEL_SPECIALIZATION_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

export const MODEL_SPECIALIZATION_FALLBACK: ModelSpecializationResult = {
  model_specialization: "unclear",
  reason: "",
  confidence: 0,
};
