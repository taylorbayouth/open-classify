// Result type, validator, and fallback for the tools classifier. Emits a
// boolean `needed` plus the set of `families` the downstream model should
// have access to. The aggregator unions families across contributors via
// the `tool_families` envelope slot.

import {
  TOOL_FAMILY_VALUES,
  type ToolFamily,
} from "../../enums.js";
import {
  ensureExactKeys,
  ensureNoDuplicates,
  isRecord,
  requireBoolean,
  requireConfidence,
  requireEnum,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const TOOLS_REASON_MAX_CHARS = 200;

export interface ToolsResult extends ClassifierResultBase {
  needed: boolean;
  families: ToolFamily[];
}

export function validateTools(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): ToolsResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["needed", "families", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  const needed = requireBoolean(value.needed, ctx.name, ctx.model, "needed");
  if (!Array.isArray(value.families)) {
    throwInvalid(ctx.name, ctx.model, "families must be an array");
  }
  const families = value.families.map((item, index) =>
    requireEnum(item, TOOL_FAMILY_VALUES, ctx.name, ctx.model, `families[${index}]`),
  );
  ensureNoDuplicates(families, ctx.name, ctx.model, "families");
  if (needed !== (families.length > 0)) {
    throwInvalid(ctx.name, ctx.model, "needed must match whether families is non-empty");
  }

  return {
    needed,
    families,
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      TOOLS_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

export const TOOLS_FALLBACK: ToolsResult = {
  needed: false,
  families: [],
  reason: "",
  confidence: 0,
};
