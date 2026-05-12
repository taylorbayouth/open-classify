import {
  DOWNSTREAM_EXECUTION_MODE_VALUES,
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
  SECURITY_DECISION_VALUES,
} from "./enums.js";
import { Ajv, type AnySchema } from "ajv/dist/ajv.js";
import type { JsonClassifierManifest, StockClassifierOutput } from "./stock.js";
import {
  HISTORY_OLDER_MESSAGES_VALUES,
  STOCK_SIGNAL_KEYS,
} from "./stock.js";
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
  requireStringMaxLength,
  throwInvalid,
} from "./validation.js";

export const STOCK_REASON_MAX_CHARS = 120;
export const STOCK_REPLY_MAX_CHARS = 200;
export const STOCK_SUMMARY_TARGET_MAX_CHARS = 200;
export const STOCK_SUMMARY_WINDOW_MAX_CHARS = 800;
export const STOCK_TOOL_FAMILY_ID_MAX_CHARS = 64;
export const STOCK_TOOL_FAMILY_DESCRIPTION_MAX_CHARS = 240;
export const STOCK_MANIFEST_NAME_MAX_CHARS = 80;
export const STOCK_MANIFEST_VERSION_MAX_CHARS = 40;
export const STOCK_MANIFEST_PURPOSE_MAX_CHARS = 400;

const STOCK_CONTEXT_STATUS_VALUES = [
  "standalone",
  "sufficient",
  "insufficient",
  "unknown",
] as const;

const STOCK_HANDOFF_KIND_VALUES = ["route", "final", "block"] as const;
const STOCK_SAFETY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unknown",
] as const;
const STOCK_UI_RENDERER_VALUES = ["enum", "list", "object", "boolean"] as const;

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateJsonClassifierManifest(
  value: unknown,
  model = "manifest",
): JsonClassifierManifest {
  if (!isRecord(value)) {
    throwInvalid("manifest", model, "manifest must be a JSON object");
  }
  ensureAllowedObjectKeys(
    value,
    [
      "name",
      "version",
      "purpose",
      "order",
      "emits",
      "fallback",
      "short_circuit",
      "tool_families",
      "output_schema",
      "backend",
      "ui",
    ],
    "manifest",
    model,
    "manifest",
  );

  const name = requireNonEmptyStringMaxLength(
    value.name,
    "manifest",
    model,
    "name",
    STOCK_MANIFEST_NAME_MAX_CHARS,
  );
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

  if (!isRecord(value.emits)) {
    throwInvalid("manifest", model, "emits is required and must be an object");
  }
  const emits: JsonClassifierManifest["emits"] = {};
  for (const [key, enabled] of Object.entries(value.emits)) {
    if (!STOCK_SIGNAL_KEYS.includes(key as (typeof STOCK_SIGNAL_KEYS)[number])) {
      throwInvalid("manifest", model, `emits.${key} is not a supported stock signal`);
    }
    emits[key as keyof JsonClassifierManifest["emits"]] = requireBoolean(
      enabled,
      "manifest",
      model,
      `emits.${key}`,
    );
  }

  const toolFamilies = value.tool_families === undefined
    ? undefined
    : validateToolFamilies(value.tool_families, model);
  if (emits.output === true && value.output_schema === undefined) {
    throwInvalid("manifest", model, "output_schema is required when emits.output is true");
  }
  const outputSchema = value.output_schema;
  if (outputSchema !== undefined) {
    compileOutputSchema(outputSchema, "manifest", model);
  }
  const fallback = validateStockClassifierOutput(value.fallback, {
    classifier: name,
    model,
    emits,
    toolFamilies: toolFamilies?.map((family) => family.id),
    outputSchema,
  });

  return {
    name,
    version,
    purpose,
    order,
    emits,
    fallback,
    ...(value.short_circuit === undefined
      ? {}
      : { short_circuit: validateShortCircuit(value.short_circuit, model) }),
    ...(toolFamilies === undefined ? {} : { tool_families: toolFamilies }),
    ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
    ...(value.backend === undefined ? {} : { backend: validateBackend(value.backend, model) }),
    ...(value.ui === undefined ? {} : { ui: validateUi(value.ui, model) }),
  };
}

interface ValidateOutputOptions {
  readonly classifier: string;
  readonly model: string;
  readonly emits?: JsonClassifierManifest["emits"];
  readonly toolFamilies?: ReadonlyArray<string>;
  readonly outputSchema?: unknown;
}

export function validateStockClassifierOutput(
  value: unknown,
  options: ValidateOutputOptions,
): StockClassifierOutput {
  const { classifier, model, emits, toolFamilies } = options;
  if (!isRecord(value)) {
    throwInvalid(classifier, model, "output must be a JSON object");
  }

  const allowedKeys = new Set(["reason", "confidence"]);
  for (const key of STOCK_SIGNAL_KEYS) {
    if (emits?.[key]) allowedKeys.add(key);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throwInvalid(classifier, model, `${key} is not declared in emits`);
    }
  }

  const output: StockClassifierOutput = {
    reason: truncateText(
      requireString(value.reason, classifier, model, "reason"),
      STOCK_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, classifier, model),
  };

  const out: StockClassifierOutput = {
    ...output,
    ...(value.handoff === undefined ? {} : { handoff: validateHandoff(value.handoff, classifier, model) }),
    ...(value.routing === undefined ? {} : { routing: validateRouting(value.routing, classifier, model) }),
    ...(value.context === undefined ? {} : { context: validateContext(value.context, classifier, model) }),
    ...(value.tools === undefined
      ? {}
      : { tools: validateTools(value.tools, classifier, model, toolFamilies) }),
    ...(value.response === undefined ? {} : { response: validateResponse(value.response, classifier, model) }),
    ...(value.safety === undefined ? {} : { safety: validateSafety(value.safety, classifier, model) }),
    ...(value.summary === undefined ? {} : { summary: validateSummary(value.summary, classifier, model) }),
    ...(value.output === undefined ? {} : { output: value.output }),
  };
  if (value.output !== undefined && options.outputSchema !== undefined) {
    validateWithSchema(value.output, options.outputSchema, classifier, model, "output");
  }
  return out;
}

function validateHandoff(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "handoff must be an object");
  const kind = requireEnum(value.kind, STOCK_HANDOFF_KIND_VALUES, classifier, model, "handoff.kind");
  if (kind === "route") {
    ensureAllowedObjectKeys(value, ["kind", "ack_reply"], classifier, model, "handoff");
    return {
      kind,
      ...(value.ack_reply === undefined
        ? {}
        : {
            ack_reply: requireNonEmptyStringMaxLength(
              value.ack_reply,
              classifier,
              model,
              "handoff.ack_reply",
              STOCK_REPLY_MAX_CHARS,
            ),
          }),
    };
  }
  if (kind === "final") {
    ensureAllowedObjectKeys(value, ["kind", "reply"], classifier, model, "handoff");
    const reply = requireString(value.reply, classifier, model, "handoff.reply");
    if (reply.trim().length === 0) {
      throwInvalid(classifier, model, "handoff.reply must not be empty");
    }
    if (classifier === "preflight" && reply.length > STOCK_REPLY_MAX_CHARS) {
      return { kind: "route" as const };
    }
    if (reply.length > STOCK_REPLY_MAX_CHARS) {
      throwInvalid(classifier, model, `handoff.reply must be ${STOCK_REPLY_MAX_CHARS} characters or fewer`);
    }
    return {
      kind,
      reply,
    };
  }
  ensureAllowedObjectKeys(value, ["kind", "reason_code"], classifier, model, "handoff");
  return {
    kind,
    ...(value.reason_code === undefined
      ? {}
      : { reason_code: requireString(value.reason_code, classifier, model, "handoff.reason_code") }),
  };
}

function validateRouting(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "routing must be an object");
  ensureAllowedObjectKeys(
    value,
    ["execution_mode", "model_tier", "specialization"],
    classifier,
    model,
    "routing",
  );
  return {
    ...(value.execution_mode === undefined
      ? {}
      : {
          execution_mode: requireEnum(
            value.execution_mode,
            withoutEscapeHatch(DOWNSTREAM_EXECUTION_MODE_VALUES, "unable_to_determine"),
            classifier,
            model,
            "routing.execution_mode",
          ),
        }),
    ...(value.model_tier === undefined
      ? {}
      : {
          model_tier: requireEnum(
            value.model_tier,
            withoutEscapeHatch(DOWNSTREAM_MODEL_TIER_VALUES, "unable_to_determine"),
            classifier,
            model,
            "routing.model_tier",
          ),
        }),
    ...(value.specialization === undefined
      ? {}
      : {
          specialization: requireEnum(
            value.specialization,
            withoutEscapeHatch(MODEL_SPECIALIZATION_VALUES, "unclear"),
            classifier,
            model,
            "routing.specialization",
          ),
        }),
  };
}

function validateContext(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "context must be an object");
  const status = requireEnum(
    value.status,
    STOCK_CONTEXT_STATUS_VALUES,
    classifier,
    model,
    "context.status",
  );
  if (status === "sufficient") {
    ensureAllowedObjectKeys(
      value,
      ["status", "include_prior_messages"],
      classifier,
      model,
      "context",
    );
    return {
      status,
      include_prior_messages: requireNonNegativeSafeInteger(
        value.include_prior_messages,
        classifier,
        model,
        "context.include_prior_messages",
      ),
    };
  }
  ensureAllowedObjectKeys(value, ["status", "include_prior_messages"], classifier, model, "context");
  return { status };
}

function validateTools(
  value: unknown,
  classifier: string,
  model: string,
  toolFamilies: ReadonlyArray<string> | undefined,
) {
  if (!isRecord(value)) throwInvalid(classifier, model, "tools must be an object");
  ensureAllowedObjectKeys(value, ["required", "families"], classifier, model, "tools");
  const families = requireStringArray(value.families, classifier, model, "tools.families")
    .map(normalizeToolFamily);
  const required = families.length > 0
    ? true
    : requireBoolean(value.required, classifier, model, "tools.required");
  ensureNoDuplicates(families, classifier, model, "tools.families");
  if (toolFamilies) {
    const allowed = new Set(toolFamilies);
    for (const family of families) {
      if (!allowed.has(family)) {
        throwInvalid(classifier, model, `tools.families includes unsupported family ${family}`);
      }
    }
  }
  return { required, families };
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

function validateResponse(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "response must be an object");
  ensureAllowedObjectKeys(value, ["language", "locale"], classifier, model, "response");
  return {
    ...(value.language === undefined
      ? {}
      : { language: requireString(value.language, classifier, model, "response.language") }),
    ...(value.locale === undefined
      ? {}
      : { locale: requireString(value.locale, classifier, model, "response.locale") }),
  };
}

function validateSafety(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "safety must be an object");
  ensureAllowedObjectKeys(value, ["decision", "risk_level", "signals"], classifier, model, "safety");
  const decision = value.decision === undefined
    ? undefined
    : requireEnum(
        value.decision,
        SECURITY_DECISION_VALUES,
        classifier,
        model,
        "safety.decision",
      );
  const riskLevel = requireEnum(
    value.risk_level,
    STOCK_SAFETY_RISK_LEVEL_VALUES,
    classifier,
    model,
    "safety.risk_level",
  );
  const signals = requireStringArray(value.signals, classifier, model, "safety.signals");
  ensureNoDuplicates(signals, classifier, model, "safety.signals");
  if ((riskLevel === "normal" || riskLevel === "unknown") && signals.length > 0) {
    throwInvalid(classifier, model, `${riskLevel} safety.risk_level must not include signals`);
  }
  if (riskLevel !== "normal" && riskLevel !== "unknown" && signals.length === 0) {
    throwInvalid(classifier, model, "elevated safety.risk_level must include at least one signal");
  }
  if (decision === "block" && riskLevel !== "high_risk") {
    throwInvalid(classifier, model, "safety.decision block requires high_risk risk_level");
  }
  if (decision === "allow" && riskLevel === "high_risk") {
    throwInvalid(classifier, model, "safety.decision allow must not use high_risk risk_level");
  }
  return {
    ...(decision === undefined ? {} : { decision }),
    risk_level: riskLevel,
    signals,
  };
}

function validateSummary(value: unknown, classifier: string, model: string) {
  if (!isRecord(value)) throwInvalid(classifier, model, "summary must be an object");
  ensureAllowedObjectKeys(
    value,
    ["target_message", "conversation_window"],
    classifier,
    model,
    "summary",
  );
  return {
    ...(value.target_message === undefined
      ? {}
      : {
          target_message: requireStringMaxLength(
            value.target_message,
            classifier,
            model,
            "summary.target_message",
            STOCK_SUMMARY_TARGET_MAX_CHARS,
          ),
        }),
    ...(value.conversation_window === undefined
      ? {}
      : {
          conversation_window: requireStringMaxLength(
            value.conversation_window,
            classifier,
            model,
            "summary.conversation_window",
            STOCK_SUMMARY_WINDOW_MAX_CHARS,
          ),
        }),
  };
}

function validateToolFamilies(value: unknown, model: string) {
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

function validateShortCircuit(value: unknown, model: string) {
  if (!isRecord(value)) {
    throwInvalid("manifest", model, "short_circuit must be an object");
  }
  ensureAllowedObjectKeys(
    value,
    ["priority", "kinds", "safety_decisions"],
    "manifest",
    model,
    "short_circuit",
  );
  if (value.kinds === undefined && value.safety_decisions === undefined) {
    throwInvalid("manifest", model, "short_circuit requires kinds or safety_decisions");
  }
  const kinds = value.kinds === undefined ? undefined : validateShortCircuitValues(
    value.kinds,
    STOCK_HANDOFF_KIND_VALUES,
    model,
    "short_circuit.kinds",
  );
  const safetyDecisions = value.safety_decisions === undefined ? undefined : validateShortCircuitValues(
    value.safety_decisions,
    SECURITY_DECISION_VALUES,
    model,
    "short_circuit.safety_decisions",
  );
  return {
    priority: requireNonNegativeSafeInteger(
      value.priority,
      "manifest",
      model,
      "short_circuit.priority",
    ),
    ...(kinds === undefined ? {} : { kinds }),
    ...(safetyDecisions === undefined ? {} : { safety_decisions: safetyDecisions }),
  };
}

function validateShortCircuitValues<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  model: string,
  path: string,
): T[] {
  if (!Array.isArray(value)) {
    throwInvalid("manifest", model, `${path} must be an array`);
  }
  const out = value.map((item, index) =>
    requireEnum(item, allowed, "manifest", model, `${path}[${index}]`),
  );
  ensureNoDuplicates(out, "manifest", model, path);
  return out;
}

function validateBackend(value: unknown, model: string) {
  if (!isRecord(value)) throwInvalid("manifest", model, "backend must be an object");
  ensureAllowedObjectKeys(value, ["ollama"], "manifest", model, "backend");
  if (value.ollama === undefined) return {};
  if (!isRecord(value.ollama)) {
    throwInvalid("manifest", model, "backend.ollama must be an object");
  }
  ensureAllowedObjectKeys(
    value.ollama,
    ["base_model", "adapter_model"],
    "manifest",
    model,
    "backend.ollama",
  );
  return {
    ollama: {
      ...(value.ollama.base_model === undefined
        ? {}
        : { base_model: requireString(value.ollama.base_model, "manifest", model, "backend.ollama.base_model") }),
      ...(value.ollama.adapter_model === undefined
        ? {}
        : {
            adapter_model: requireString(
              value.ollama.adapter_model,
              "manifest",
              model,
              "backend.ollama.adapter_model",
            ),
          }),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutEscapeHatch<const Values extends readonly string[], Escape extends Values[number]>(
  values: Values,
  escape: Escape,
): Exclude<Values[number], Escape>[] {
  return values.filter((value): value is Exclude<Values[number], Escape> => value !== escape);
}

export { HISTORY_OLDER_MESSAGES_VALUES };
