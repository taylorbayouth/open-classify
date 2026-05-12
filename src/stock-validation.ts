import {
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
  SECURITY_DECISION_VALUES,
} from "./enums.js";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import type {
  CustomJsonManifest,
  JsonClassifierManifest,
  PreflightClassifierOutput,
  RoutingClassifierOutput,
  SafetySignal,
  SecurityClassifierOutput,
  StockClassifierName,
  StockClassifierOutputs,
  StockJsonManifest,
  ToolsClassifierOutput,
  CustomClassifierOutputValue,
  ClassifierOutput,
  ToolFamilyDefinition,
} from "./stock.js";
import { STOCK_CLASSIFIER_NAMES } from "./stock.js";
import {
  ensureNoDuplicates,
  isRecord,
  requireBoolean,
  requireConfidence,
  requireEnum,
  requireNonEmptyStringMaxLength,
  requireNonNegativeSafeInteger,
  requireString,
  requireStringArray,
  throwInvalid,
} from "./validation.js";

export const STOCK_REASON_MAX_CHARS = 120;
export const STOCK_REPLY_MAX_CHARS = 200;
export const STOCK_TOOL_FAMILY_ID_MAX_CHARS = 64;
export const STOCK_TOOL_FAMILY_DESCRIPTION_MAX_CHARS = 240;
export const STOCK_MANIFEST_NAME_MAX_CHARS = 80;
export const STOCK_MANIFEST_VERSION_MAX_CHARS = 40;
export const STOCK_MANIFEST_PURPOSE_MAX_CHARS = 400;

const STOCK_SAFETY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unknown",
] as const;
const STOCK_UI_RENDERER_VALUES = ["enum", "list", "object", "boolean"] as const;
const MANIFEST_KIND_VALUES = ["stock", "custom"] as const;

const ajv = new Ajv({ allErrors: true, strict: false });

const COMMON_MANIFEST_KEYS = [
  "kind",
  "name",
  "version",
  "purpose",
  "order",
  "fallback",
  "backend",
  "ui",
] as const;

const STOCK_MANIFEST_KEYS = [
  ...COMMON_MANIFEST_KEYS,
  "tool_families",
] as const;

const CUSTOM_MANIFEST_KEYS = [
  ...COMMON_MANIFEST_KEYS,
  "output_schema",
] as const;

export function validateJsonClassifierManifest(
  value: unknown,
  model = "manifest",
): JsonClassifierManifest {
  if (!isRecord(value)) {
    throwInvalid("manifest", model, "manifest must be a JSON object");
  }
  const kind = requireEnum(value.kind, MANIFEST_KIND_VALUES, "manifest", model, "kind");
  return kind === "stock"
    ? validateStockManifest(value, model)
    : validateCustomManifest(value, model);
}

function validateStockManifest(
  value: Record<string, unknown>,
  model: string,
): StockJsonManifest {
  ensureAllowedObjectKeys(value, STOCK_MANIFEST_KEYS, "manifest", model, "manifest");
  const name = requireEnum(
    value.name,
    STOCK_CLASSIFIER_NAMES,
    "manifest",
    model,
    "name",
  );
  const base = validateManifestCommon(value, model);
  const toolFamilies =
    value.tool_families === undefined
      ? undefined
      : validateToolFamilies(value.tool_families, model);

  if (name !== "tools" && toolFamilies !== undefined) {
    throwInvalid(
      "manifest",
      model,
      "tool_families is only supported on the tools classifier",
    );
  }

  const fallback = validateStockOutputForName(name, value.fallback, model, toolFamilies);

  return {
    kind: "stock",
    name,
    ...base,
    fallback,
    ...(toolFamilies === undefined ? {} : { tool_families: toolFamilies }),
  };
}

function validateCustomManifest(
  value: Record<string, unknown>,
  model: string,
): CustomJsonManifest {
  ensureAllowedObjectKeys(value, CUSTOM_MANIFEST_KEYS, "manifest", model, "manifest");
  const name = requireNonEmptyStringMaxLength(
    value.name,
    "manifest",
    model,
    "name",
    STOCK_MANIFEST_NAME_MAX_CHARS,
  );
  if ((STOCK_CLASSIFIER_NAMES as ReadonlyArray<string>).includes(name)) {
    throwInvalid(
      "manifest",
      model,
      `custom classifier name "${name}" collides with a stock classifier`,
    );
  }
  const base = validateManifestCommon(value, model);
  if (value.output_schema === undefined) {
    throwInvalid("manifest", model, "output_schema is required for custom classifiers");
  }
  const outputSchema = value.output_schema;
  compileOutputSchema(outputSchema, "manifest", model);
  const fallback = validateCustomOutput(value.fallback, name, model, outputSchema);

  return {
    kind: "custom",
    name,
    ...base,
    fallback,
    output_schema: outputSchema,
  };
}

function validateManifestCommon(
  value: Record<string, unknown>,
  model: string,
): {
  version: string;
  purpose: string;
  order: number;
  backend?: JsonClassifierManifest["backend"];
  ui?: JsonClassifierManifest["ui"];
} {
  const version = requireNonEmptyStringMaxLength(
    value.version,
    "manifest",
    model,
    "version",
    STOCK_MANIFEST_VERSION_MAX_CHARS,
  );
  const purpose = requireNonEmptyStringMaxLength(
    value.purpose,
    "manifest",
    model,
    "purpose",
    STOCK_MANIFEST_PURPOSE_MAX_CHARS,
  );
  const order = requireNonNegativeSafeInteger(value.order, "manifest", model, "order");

  return {
    version,
    purpose,
    order,
    ...(value.backend === undefined ? {} : { backend: validateBackend(value.backend, model) }),
    ...(value.ui === undefined ? {} : { ui: validateUi(value.ui, model) }),
  };
}

// ─── Output validation ──────────────────────────────────────────────────────

export interface ValidateOutputContext {
  readonly classifier: string;
  readonly model: string;
}

export function validateOutputForManifest(
  manifest: JsonClassifierManifest,
  value: unknown,
  context: ValidateOutputContext,
): ClassifierOutput {
  if (manifest.kind === "stock") {
    return validateStockOutputForName(
      manifest.name,
      value,
      context.model,
      manifest.tool_families,
    );
  }
  return validateCustomOutput(value, context.classifier, context.model, manifest.output_schema);
}

function validateStockOutputForName<Name extends StockClassifierName>(
  name: Name,
  value: unknown,
  model: string,
  toolFamilies: ReadonlyArray<ToolFamilyDefinition> | undefined,
): StockClassifierOutputs[Name] {
  if (!isRecord(value)) {
    throwInvalid(name, model, "output must be a JSON object");
  }
  switch (name) {
    case "preflight":
      return validatePreflightOutput(value, model) as StockClassifierOutputs[Name];
    case "routing":
      return validateRoutingOutput(value, name, model) as StockClassifierOutputs[Name];
    case "model_specialization":
      return validateRoutingOutput(value, name, model) as StockClassifierOutputs[Name];
    case "tools":
      return validateToolsOutput(value, model, toolFamilies?.map((f) => f.id)) as StockClassifierOutputs[Name];
    case "security":
      return validateSecurityOutput(value, model) as StockClassifierOutputs[Name];
    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      throwInvalid("manifest", model, `unknown stock classifier name`);
    }
  }
}

function validateMetadata(
  value: Record<string, unknown>,
  classifier: string,
  model: string,
): { reason?: string; confidence?: number } {
  return {
    ...(value.reason === undefined
      ? {}
      : { reason: truncateText(requireString(value.reason, classifier, model, "reason"), STOCK_REASON_MAX_CHARS) }),
    ...(value.confidence === undefined
      ? {}
      : { confidence: requireConfidence(value.confidence, classifier, model) }),
  };
}

function validatePreflightOutput(
  value: Record<string, unknown>,
  model: string,
): PreflightClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "confidence", "final_reply", "ack_reply"], "preflight", model, "output");
  const meta = validateMetadata(value, "preflight", model);
  return {
    ...meta,
    ...(value.final_reply === undefined
      ? {}
      : { final_reply: validateReplySignal(value.final_reply, "preflight", model, "final_reply") }),
    ...(value.ack_reply === undefined
      ? {}
      : { ack_reply: validateReplySignal(value.ack_reply, "preflight", model, "ack_reply") }),
  };
}

function validateReplySignal(
  value: unknown,
  classifier: string,
  model: string,
  field: "final_reply" | "ack_reply",
): { reply: string } {
  if (!isRecord(value)) {
    throwInvalid(classifier, model, `${field} must be an object`);
  }
  ensureAllowedObjectKeys(value, ["reply"], classifier, model, field);
  const reply = requireString(value.reply, classifier, model, `${field}.reply`);
  if (reply.trim().length === 0) {
    throwInvalid(classifier, model, `${field}.reply must not be empty`);
  }
  if (reply.length > STOCK_REPLY_MAX_CHARS) {
    throwInvalid(
      classifier,
      model,
      `${field}.reply must be ${STOCK_REPLY_MAX_CHARS} characters or fewer`,
    );
  }
  return { reply };
}

function validateRoutingOutput(
  value: Record<string, unknown>,
  classifier: string,
  model: string,
): RoutingClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "confidence", "model_tier", "specialization"], classifier, model, "output");
  const meta = validateMetadata(value, classifier, model);
  return {
    ...meta,
    ...(value.model_tier === undefined
      ? {}
      : { model_tier: requireEnum(value.model_tier, DOWNSTREAM_MODEL_TIER_VALUES, classifier, model, "model_tier") }),
    ...(value.specialization === undefined
      ? {}
      : { specialization: requireEnum(value.specialization, MODEL_SPECIALIZATION_VALUES, classifier, model, "specialization") }),
  };
}

function validateToolsOutput(
  value: Record<string, unknown>,
  model: string,
  toolFamilies: ReadonlyArray<string> | undefined,
): ToolsClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "confidence", "required", "families"], "tools", model, "output");
  const meta = validateMetadata(value, "tools", model);
  const families = requireStringArray(value.families, "tools", model, "families").map(normalizeToolFamily);
  ensureNoDuplicates(families, "tools", model, "families");
  if (toolFamilies) {
    const allowed = new Set(toolFamilies);
    for (const family of families) {
      if (!allowed.has(family)) {
        throwInvalid("tools", model, `families includes unsupported family ${family}`);
      }
    }
  }
  const required =
    families.length > 0
      ? true
      : requireBoolean(value.required, "tools", model, "required");
  return { ...meta, required, families };
}

function validateSecurityOutput(
  value: Record<string, unknown>,
  model: string,
): SecurityClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "confidence", "decision", "risk_level", "signals"], "security", model, "output");
  const meta = validateMetadata(value, "security", model);
  const decision =
    value.decision === undefined
      ? undefined
      : requireEnum(value.decision, SECURITY_DECISION_VALUES, "security", model, "decision");
  const riskLevel = requireEnum(
    value.risk_level,
    STOCK_SAFETY_RISK_LEVEL_VALUES,
    "security",
    model,
    "risk_level",
  );
  const signals = requireStringArray(value.signals, "security", model, "signals");
  ensureNoDuplicates(signals, "security", model, "signals");
  if ((riskLevel === "normal" || riskLevel === "unknown") && signals.length > 0) {
    throwInvalid("security", model, `${riskLevel} risk_level must not include signals`);
  }
  if (riskLevel !== "normal" && riskLevel !== "unknown" && signals.length === 0) {
    throwInvalid("security", model, "elevated risk_level must include at least one signal");
  }
  if (decision === "block" && riskLevel !== "high_risk") {
    throwInvalid("security", model, "decision block requires high_risk risk_level");
  }
  if (decision === "allow" && riskLevel === "high_risk") {
    throwInvalid("security", model, "decision allow must not use high_risk risk_level");
  }
  return {
    ...meta,
    ...(decision === undefined ? {} : { decision }),
    risk_level: riskLevel,
    signals,
  };
}

function validateCustomOutput(
  value: unknown,
  classifier: string,
  model: string,
  schema: unknown,
): CustomClassifierOutputValue {
  if (!isRecord(value)) {
    throwInvalid(classifier, model, "output must be a JSON object");
  }
  ensureAllowedObjectKeys(value, ["reason", "confidence", "output"], classifier, model, "output");
  if (value.output === undefined) {
    throwInvalid(classifier, model, "output is required for custom classifiers");
  }
  const meta = validateMetadata(value, classifier, model);
  validateWithSchema(value.output, schema, classifier, model, "output");
  return { ...meta, output: value.output };
}

function validateToolFamilies(value: unknown, model: string): ToolFamilyDefinition[] {
  if (!Array.isArray(value)) {
    throwInvalid("manifest", model, "tool_families must be an array");
  }
  const out = value.map((item, index) => {
    if (!isRecord(item)) {
      throwInvalid("manifest", model, `tool_families[${index}] must be an object`);
    }
    return {
      id: requireNonEmptyStringMaxLength(
        item.id,
        "manifest",
        model,
        `tool_families[${index}].id`,
        STOCK_TOOL_FAMILY_ID_MAX_CHARS,
      ),
      description: requireNonEmptyStringMaxLength(
        item.description,
        "manifest",
        model,
        `tool_families[${index}].description`,
        STOCK_TOOL_FAMILY_DESCRIPTION_MAX_CHARS,
      ),
    };
  });
  ensureNoDuplicates(out.map((item) => item.id), "manifest", model, "tool_families[].id");
  return out;
}

function validateBackend(value: unknown, model: string) {
  if (!isRecord(value)) throwInvalid("manifest", model, "backend must be an object");
  ensureAllowedObjectKeys(value, ["ollama"], "manifest", model, "backend");
  if (value.ollama === undefined) return {};
  if (!isRecord(value.ollama)) {
    throwInvalid("manifest", model, "backend.ollama must be an object");
  }
  ensureAllowedObjectKeys(value.ollama, ["base_model"], "manifest", model, "backend.ollama");
  return {
    ollama: {
      ...(value.ollama.base_model === undefined
        ? {}
        : { base_model: requireString(value.ollama.base_model, "manifest", model, "backend.ollama.base_model") }),
    },
  };
}

function validateUi(value: unknown, model: string) {
  if (!isRecord(value)) throwInvalid("manifest", model, "ui must be an object");
  ensureAllowedObjectKeys(value, ["label", "renderer"], "manifest", model, "ui");
  return {
    ...(value.label === undefined
      ? {}
      : { label: requireString(value.label, "manifest", model, "ui.label") }),
    ...(value.renderer === undefined
      ? {}
      : {
          renderer: requireEnum(
            value.renderer,
            STOCK_UI_RENDERER_VALUES,
            "manifest",
            model,
            "ui.renderer",
          ),
        }),
  };
}

function ensureAllowedObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  classifier: string,
  model: string,
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throwInvalid(classifier, model, `${path}.${key} is not a supported field`);
    }
  }
}

function compileOutputSchema(schema: unknown, classifier: string, model: string): void {
  try {
    ajv.compile(schema as AnySchema);
  } catch (error) {
    throwInvalid(classifier, model, `output_schema is invalid JSON Schema: ${errorMessage(error)}`);
  }
}

export function validateWithSchema(
  value: unknown,
  schema: unknown,
  classifier: string,
  model: string,
  path: string,
): void {
  const validate = ajv.compile(schema as AnySchema);
  if (!validate(value)) {
    const message = ajv.errorsText(validate.errors, { dataVar: path });
    throwInvalid(classifier, model, message);
  }
}

function normalizeToolFamily(family: string): string {
  const aliases: Record<string, string> = {
    browser: "web",
    browsing: "web",
    internet: "web",
    web_browsing: "web",
    web_search: "web",
  };
  return aliases[family] ?? family;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Backwards-compatible helper preserved for backends that still need a
// one-call validator keyed by (classifier name, raw value).
export interface LegacyValidateOptions {
  readonly classifier: string;
  readonly model: string;
  readonly manifest: JsonClassifierManifest;
}

export function validateClassifierOutputWithManifest(
  value: unknown,
  options: LegacyValidateOptions,
): ClassifierOutput {
  return validateOutputForManifest(options.manifest, value, {
    classifier: options.classifier,
    model: options.model,
  });
}

// Helper used by `SafetySignal` checks elsewhere — kept as a typed re-export.
export type { SafetySignal };
