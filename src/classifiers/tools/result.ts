import { TOOL_FAMILY_VALUES, type ToolFamily } from "../../enums.js";
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
  if (typeof value.needed !== "boolean") {
    throwInvalid(ctx.name, ctx.model, "needed must be a boolean");
  }
  if (!Array.isArray(value.families)) {
    throwInvalid(ctx.name, ctx.model, "families must be an array");
  }
  const families = value.families.map((item, index) =>
    requireEnum(item, TOOL_FAMILY_VALUES, ctx.name, ctx.model, `families[${index}]`),
  );
  ensureNoDuplicates(families, ctx.name, ctx.model, "families");
  if (value.needed !== (families.length > 0)) {
    throwInvalid(
      ctx.name,
      ctx.model,
      "needed must match whether families is non-empty",
    );
  }

  return {
    needed: value.needed,
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
