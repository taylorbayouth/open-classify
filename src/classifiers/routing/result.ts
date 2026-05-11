// Result type, validator, and fallback for the routing classifier. Two
// signals are emitted: `execution_mode` (direct/tool_assisted/workflow) and
// `model_tier` (local_fast → frontier_strong). The aggregator's resolver
// reads both, combined with model_specialization, to pick a catalog entry.

import {
  DOWNSTREAM_EXECUTION_MODE_VALUES,
  DOWNSTREAM_MODEL_TIER_VALUES,
  type DownstreamExecutionMode,
  type DownstreamModelTier,
} from "../../enums.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";
import {
  ensureExactKeys,
  isRecord,
  requireConfidence,
  requireEnum,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";

export const ROUTING_REASON_MAX_CHARS = 200;

export interface RoutingResult extends ClassifierResultBase {
  execution_mode: DownstreamExecutionMode;
  model_tier: DownstreamModelTier;
}

export function validateRouting(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): RoutingResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["execution_mode", "model_tier", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  return {
    execution_mode: requireEnum(
      value.execution_mode,
      DOWNSTREAM_EXECUTION_MODE_VALUES,
      ctx.name,
      ctx.model,
      "execution_mode",
    ),
    model_tier: requireEnum(
      value.model_tier,
      DOWNSTREAM_MODEL_TIER_VALUES,
      ctx.name,
      ctx.model,
      "model_tier",
    ),
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      ROUTING_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

// Conservative fallback. `unable_to_determine` on both axes signals the
// resolver to drop these constraints (escape_hatch); `confidence: 0` makes
// the aggregator ignore any threshold-gated signal from this entry.
export const ROUTING_FALLBACK: RoutingResult = {
  execution_mode: "unable_to_determine",
  model_tier: "unable_to_determine",
  reason: "",
  confidence: 0,
};
