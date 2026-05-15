import {
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
} from "./enums.js";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import type {
  CustomJsonManifest,
  JsonClassifierManifest,
  Certainty,
  ModelSpecializationClassifierOutput,
  PreflightClassifierOutput,
  PromptInjectionClassifierOutput,
  RoutingClassifierOutput,
  StockClassifierName,
  StockClassifierOutputs,
  StockJsonManifest,
  ToolsClassifierOutput,
  CustomClassifierOutputValue,
  ClassifierOutput,
  ToolDefinition,
} from "./stock.js";
import { CERTAINTY_VALUES, STOCK_CLASSIFIER_NAMES } from "./stock.js";
import {
  ensureNoDuplicates,
  isRecord,
  requireEnum,
  requireNonEmptyStringMaxLength,
  requireNonNegativeSafeInteger,
  requireString,
  requireStringArray,
  throwInvalid,
} from "./validation.js";

export const STOCK_REASON_MAX_CHARS = 120;
export const STOCK_REPLY_MAX_CHARS = 200;
export const STOCK_TOOL_ID_MAX_CHARS = 64;
export const STOCK_TOOL_DESCRIPTION_MAX_CHARS = 240;
export const STOCK_MANIFEST_NAME_MAX_CHARS = 80;
export const STOCK_MANIFEST_VERSION_MAX_CHARS = 40;
export const STOCK_MANIFEST_PURPOSE_MAX_CHARS = 400;

const STOCK_PROMPT_INJECTION_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unknown",
] as const;
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
] as const;

const STOCK_MANIFEST_KEYS = [
  ...COMMON_MANIFEST_KEYS,
  "tools",
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
  const tools =
    value.tools === undefined
      ? undefined
      : validateTools(value.tools, model);

  if (name !== "tools" && tools !== undefined) {
    throwInvalid(
      "manifest",
      model,
      "tools is only supported on the tools classifier",
    );
  }

  const fallback = validateStockOutputForName(name, value.fallback, model, tools);

  return {
    kind: "stock",
    name,
    ...base,
    fallback,
    ...(tools === undefined ? {} : { tools }),
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
      manifest.tools,
    );
  }
  return validateCustomOutput(value, context.classifier, context.model, manifest.output_schema);
}

function validateStockOutputForName<Name extends StockClassifierName>(
  name: Name,
  value: unknown,
  model: string,
  tools: ReadonlyArray<ToolDefinition> | undefined,
): StockClassifierOutputs[Name] {
  if (!isRecord(value)) {
    throwInvalid(name, model, "output must be a JSON object");
  }
  switch (name) {
    case "preflight":
      return validatePreflightOutput(value, model) as StockClassifierOutputs[Name];
    case "routing":
      return validateTierRoutingOutput(value, model) as StockClassifierOutputs[Name];
    case "model_specialization":
      return validateModelSpecializationOutput(value, model) as StockClassifierOutputs[Name];
    case "tools":
      return validateToolsOutput(value, model, tools?.map((tool) => tool.id)) as StockClassifierOutputs[Name];
    case "prompt_injection":
      return validatePromptInjectionOutput(value, model) as StockClassifierOutputs[Name];
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
): { reason: string; certainty: Certainty } {
  if (value.reason === undefined) {
    throwInvalid(classifier, model, "reason is required");
  }
  if (value.certainty === undefined) {
    throwInvalid(classifier, model, "certainty is required");
  }
  return {
    reason: truncateText(requireString(value.reason, classifier, model, "reason"), STOCK_REASON_MAX_CHARS),
    certainty: requireEnum(value.certainty, CERTAINTY_VALUES, classifier, model, "certainty"),
  };
}

function validatePreflightOutput(
  value: Record<string, unknown>,
  model: string,
): PreflightClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "certainty", "final_reply", "ack_reply"], "preflight", model, "output");
  if (value.final_reply !== undefined && value.ack_reply !== undefined) {
    throwInvalid(
      "preflight",
      model,
      "final_reply and ack_reply are mutually exclusive",
    );
  }
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
): { text: string } {
  if (!isRecord(value)) {
    throwInvalid(classifier, model, `${field} must be an object`);
  }
  ensureAllowedObjectKeys(value, ["text"], classifier, model, field);
  const text = requireString(value.text, classifier, model, `${field}.text`);
  if (text.trim().length === 0) {
    throwInvalid(classifier, model, `${field}.text must not be empty`);
  }
  if (text.length > STOCK_REPLY_MAX_CHARS) {
    throwInvalid(
      classifier,
      model,
      `${field}.text must be ${STOCK_REPLY_MAX_CHARS} characters or fewer`,
    );
  }
  return { text };
}

function validateTierRoutingOutput(
  value: Record<string, unknown>,
  model: string,
): RoutingClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "certainty", "model_tier"], "routing", model, "output");
  const meta = validateMetadata(value, "routing", model);
  const modelTier = normalizeOptionalEnumValue(value.model_tier);
  return {
    ...meta,
    ...(modelTier === undefined
      ? {}
      : { model_tier: requireEnum(modelTier, DOWNSTREAM_MODEL_TIER_VALUES, "routing", model, "model_tier") }),
  };
}

function validateModelSpecializationOutput(
  value: Record<string, unknown>,
  model: string,
): ModelSpecializationClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "certainty", "specialization"], "model_specialization", model, "output");
  const meta = validateMetadata(value, "model_specialization", model);
  const specialization = normalizeOptionalEnumValue(value.specialization);
  return {
    ...meta,
    ...(specialization === undefined
      ? {}
      : { specialization: requireEnum(specialization, MODEL_SPECIALIZATION_VALUES, "model_specialization", model, "specialization") }),
  };
}

function normalizeOptionalEnumValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function validateToolsOutput(
  value: Record<string, unknown>,
  model: string,
  configuredTools: ReadonlyArray<string> | undefined,
): ToolsClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "certainty", "tools"], "tools", model, "output");
  const meta = validateMetadata(value, "tools", model);
  const tools = requireStringArray(value.tools, "tools", model, "tools").map(normalizeTool);
  ensureNoDuplicates(tools, "tools", model, "tools");
  if (configuredTools) {
    const allowed = new Set(configuredTools);
    for (const tool of tools) {
      if (!allowed.has(tool)) {
        throwInvalid("tools", model, `tools includes unsupported tool ${tool}`);
      }
    }
  }
  return { ...meta, tools };
}

function validatePromptInjectionOutput(
  value: Record<string, unknown>,
  model: string,
): PromptInjectionClassifierOutput {
  ensureAllowedObjectKeys(value, ["reason", "certainty", "risk_level"], "prompt_injection", model, "output");
  const meta = validateMetadata(value, "prompt_injection", model);
  const riskLevel = requireEnum(
    value.risk_level,
    STOCK_PROMPT_INJECTION_RISK_LEVEL_VALUES,
    "prompt_injection",
    model,
    "risk_level",
  );
  return {
    ...meta,
    risk_level: riskLevel,
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
  ensureAllowedObjectKeys(value, ["reason", "certainty", "output"], classifier, model, "output");
  if (value.output === undefined) {
    throwInvalid(classifier, model, "output is required for custom classifiers");
  }
  const meta = validateMetadata(value, classifier, model);
  validateWithSchema(value.output, schema, classifier, model, "output");
  return { ...meta, output: value.output };
}

function validateTools(value: unknown, model: string): ToolDefinition[] {
  if (!Array.isArray(value)) {
    throwInvalid("manifest", model, "tools must be an array");
  }
  const out = value.map((item, index) => {
    if (!isRecord(item)) {
      throwInvalid("manifest", model, `tools[${index}] must be an object`);
    }
    return {
      id: requireNonEmptyStringMaxLength(
        item.id,
        "manifest",
        model,
        `tools[${index}].id`,
        STOCK_TOOL_ID_MAX_CHARS,
      ),
      description: requireNonEmptyStringMaxLength(
        item.description,
        "manifest",
        model,
        `tools[${index}].description`,
        STOCK_TOOL_DESCRIPTION_MAX_CHARS,
      ),
    };
  });
  ensureNoDuplicates(out.map((item) => item.id), "manifest", model, "tools[].id");
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

function normalizeTool(tool: string): string {
  const aliases: Record<string, string> = {
    browser: "web",
    browsing: "web",
    internet: "web",
    web_browsing: "web",
    web_search: "web",
  };
  return aliases[tool] ?? tool;
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
