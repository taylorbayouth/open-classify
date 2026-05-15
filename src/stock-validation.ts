// Manifest and classifier-output validation.
//
// The runtime composes every classifier's effective output schema by merging:
//
//   - required `reason` / `certainty` metadata
//   - canonical sub-schemas for each declared reserved field (optional)
//   - the manifest's own `output_schema.properties` for custom fields
//
// That composed schema is what runs against actual classifier outputs, so the
// LLM cannot emit an invalid enum value for a reserved field even if the
// manifest author forgot to constrain it themselves.

import { Ajv, type AnySchema, type ErrorObject } from "ajv/dist/ajv.js";
import { APPLIES_TO_VALUES, CERTAINTY_VALUES } from "./stock.js";
import type {
  AppliesTo,
  ClassifierOutput,
  JsonClassifierManifest,
  RuntimeClassifierManifest,
  ToolDefinition,
} from "./stock.js";
import {
  RESERVED_FIELD_EXCLUSIONS,
  RESERVED_FIELD_NAMES,
  RESERVED_FIELDS,
  isReservedFieldName,
  normalizeToolId,
  type ReservedFieldName,
} from "./reserved-fields.js";
import {
  isRecord,
  requireNonEmptyStringMaxLength,
  requireNonNegativeSafeInteger,
  requireString,
  throwInvalid,
} from "./validation.js";

export const REASON_MAX_CHARS = 120;
export const TOOL_ID_MAX_CHARS = 64;
export const TOOL_DESCRIPTION_MAX_CHARS = 240;
export const MANIFEST_NAME_MAX_CHARS = 80;
export const MANIFEST_VERSION_MAX_CHARS = 40;
export const MANIFEST_PURPOSE_MAX_CHARS = 400;

const MANIFEST_KEYS = [
  "name",
  "version",
  "purpose",
  "dispatch_order",
  "applies_to",
  "reserved_fields",
  "allowed_tools",
  "output_schema",
  "fallback",
  "backend",
] as const;

const ajv = new Ajv({ allErrors: true, strict: false });

// ─── Manifest validation ────────────────────────────────────────────────────

export interface ManifestLoadResult {
  readonly manifest: JsonClassifierManifest;
  readonly reservedFields: ReadonlyArray<ReservedFieldName>;
  readonly composedOutputSchema: unknown;
  readonly appliesTo: AppliesTo;
}

export function validateJsonClassifierManifest(
  value: unknown,
  model = "manifest",
): ManifestLoadResult {
  if (!isRecord(value)) {
    throwInvalid("manifest", model, "manifest must be a JSON object");
  }
  ensureAllowedObjectKeys(value, MANIFEST_KEYS, "manifest", model, "manifest");

  const name = requireNonEmptyStringMaxLength(
    value.name,
    "manifest",
    model,
    "name",
    MANIFEST_NAME_MAX_CHARS,
  );
  const version = requireNonEmptyStringMaxLength(
    value.version,
    "manifest",
    model,
    "version",
    MANIFEST_VERSION_MAX_CHARS,
  );
  const purpose = requireNonEmptyStringMaxLength(
    value.purpose,
    "manifest",
    model,
    "purpose",
    MANIFEST_PURPOSE_MAX_CHARS,
  );
  const dispatchOrder =
    value.dispatch_order === undefined
      ? undefined
      : requireNonNegativeSafeInteger(
          value.dispatch_order,
          "manifest",
          model,
          "dispatch_order",
        );

  const appliesTo = validateAppliesTo(value.applies_to, model);
  const reservedFields = validateReservedFields(value.reserved_fields, model);
  const allowedTools =
    value.allowed_tools === undefined
      ? undefined
      : validateAllowedTools(value.allowed_tools, model);

  if (allowedTools !== undefined && !reservedFields.includes("tools")) {
    throwInvalid(
      "manifest",
      model,
      "allowed_tools is only supported when reserved_fields includes \"tools\"",
    );
  }
  if (reservedFields.includes("tools") && allowedTools === undefined) {
    throwInvalid(
      "manifest",
      model,
      "allowed_tools is required when reserved_fields includes \"tools\"",
    );
  }

  const outputSchema = validateOutputSchemaShape(value.output_schema, reservedFields, model);
  const composedOutputSchema = composeOutputSchema(reservedFields, allowedTools, outputSchema);
  compileSchema(composedOutputSchema, "manifest", model, "composed output_schema");

  validateExamples(outputSchema, composedOutputSchema, model);

  const fallback = validateFallback(value.fallback, composedOutputSchema, name, model);
  const backend =
    value.backend === undefined ? undefined : validateBackend(value.backend, model);

  const manifest: JsonClassifierManifest = {
    name,
    version,
    purpose,
    ...(dispatchOrder === undefined ? {} : { dispatch_order: dispatchOrder }),
    ...(value.applies_to === undefined ? {} : { applies_to: appliesTo }),
    ...(reservedFields.length === 0 ? {} : { reserved_fields: reservedFields }),
    ...(allowedTools === undefined ? {} : { allowed_tools: allowedTools }),
    ...(outputSchema === undefined ? {} : { output_schema: outputSchema }),
    fallback,
    ...(backend === undefined ? {} : { backend }),
  };

  return {
    manifest,
    reservedFields,
    composedOutputSchema,
    appliesTo,
  };
}

function validateAppliesTo(raw: unknown, model: string): AppliesTo {
  if (raw === undefined) return "user";
  if (typeof raw !== "string" || !(APPLIES_TO_VALUES as readonly string[]).includes(raw)) {
    throwInvalid(
      "manifest",
      model,
      `applies_to must be one of ${APPLIES_TO_VALUES.join(", ")}`,
    );
  }
  return raw as AppliesTo;
}

function validateReservedFields(
  raw: unknown,
  model: string,
): ReadonlyArray<ReservedFieldName> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throwInvalid("manifest", model, "reserved_fields must be an array of strings");
  }
  const seen = new Set<string>();
  const result: ReservedFieldName[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string") {
      throwInvalid("manifest", model, `reserved_fields[${i}] must be a string`);
    }
    if (!isReservedFieldName(item)) {
      throwInvalid(
        "manifest",
        model,
        `reserved_fields[${i}] "${item}" is not a known reserved field. Allowed: ${RESERVED_FIELD_NAMES.join(", ")}`,
      );
    }
    if (seen.has(item)) {
      throwInvalid("manifest", model, `reserved_fields[${i}] duplicates "${item}"`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function validateAllowedTools(value: unknown, model: string): ReadonlyArray<ToolDefinition> {
  if (!Array.isArray(value)) {
    throwInvalid("manifest", model, "allowed_tools must be an array");
  }
  const ids = new Set<string>();
  const out: ToolDefinition[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) {
      throwInvalid("manifest", model, `allowed_tools[${i}] must be an object`);
    }
    ensureAllowedObjectKeys(item, ["id", "description"], "manifest", model, `allowed_tools[${i}]`);
    const id = requireNonEmptyStringMaxLength(
      item.id,
      "manifest",
      model,
      `allowed_tools[${i}].id`,
      TOOL_ID_MAX_CHARS,
    );
    const description = requireNonEmptyStringMaxLength(
      item.description,
      "manifest",
      model,
      `allowed_tools[${i}].description`,
      TOOL_DESCRIPTION_MAX_CHARS,
    );
    if (ids.has(id)) {
      throwInvalid("manifest", model, `allowed_tools[${i}].id "${id}" is duplicated`);
    }
    ids.add(id);
    out.push({ id, description });
  }
  return out;
}

function validateOutputSchemaShape(
  raw: unknown,
  reservedFields: ReadonlyArray<ReservedFieldName>,
  model: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throwInvalid("manifest", model, "output_schema must be a JSON object");
  }
  // We don't fully validate JSON Schema shape — Ajv does that when we compile
  // the composed schema. But we do enforce the no-reserved-keys rule, since
  // mixing reserved fields into properties is always a manifest error.
  const properties = raw.properties;
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      throwInvalid("manifest", model, "output_schema.properties must be a JSON object");
    }
    for (const key of Object.keys(properties)) {
      if (isReservedFieldName(key)) {
        throwInvalid(
          "manifest",
          model,
          `output_schema.properties.${key} collides with a reserved field. Declare it in reserved_fields instead.`,
        );
      }
      if (key === "reason" || key === "certainty") {
        throwInvalid(
          "manifest",
          model,
          `output_schema.properties.${key} is reserved. Do not declare it.`,
        );
      }
    }
  }
  // Examples must be an array if present. Per-example validation happens
  // after the composed schema is built so we can validate against it.
  if (raw.examples !== undefined && !Array.isArray(raw.examples)) {
    throwInvalid("manifest", model, "output_schema.examples must be an array");
  }
  void reservedFields;
  return raw;
}

function composeOutputSchema(
  reservedFields: ReadonlyArray<ReservedFieldName>,
  allowedTools: ReadonlyArray<ToolDefinition> | undefined,
  outputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const context = { allowed_tools: allowedTools };
  const properties: Record<string, unknown> = {
    reason: { type: "string", minLength: 1, maxLength: REASON_MAX_CHARS },
    certainty: { type: "string", enum: [...CERTAINTY_VALUES] },
  };

  for (const field of reservedFields) {
    properties[field] = RESERVED_FIELDS[field].subSchema(context);
  }

  const customProperties = isRecord(outputSchema?.properties)
    ? (outputSchema!.properties as Record<string, unknown>)
    : {};
  for (const [key, schema] of Object.entries(customProperties)) {
    properties[key] = schema;
  }

  const customRequired = Array.isArray(outputSchema?.required)
    ? (outputSchema!.required as ReadonlyArray<unknown>).filter(
        (key): key is string => typeof key === "string",
      )
    : [];
  const required = Array.from(new Set(["reason", "certainty", ...customRequired]));

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function validateExamples(
  outputSchema: Record<string, unknown> | undefined,
  composedSchema: unknown,
  model: string,
): void {
  if (outputSchema === undefined) return;
  const examples = outputSchema.examples;
  if (!Array.isArray(examples)) return;
  const validate = ajv.compile(composedSchema as AnySchema);
  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];
    if (!validate(example)) {
      const message = formatSchemaErrors(validate.errors, `examples[${i}]`);
      throwInvalid("manifest", model, `output_schema.examples[${i}] is invalid: ${message}`);
    }
    if (isRecord(example)) {
      enforceMutualExclusions(example, "manifest", model, `output_schema.examples[${i}]`);
    }
  }
}

function validateFallback(
  raw: unknown,
  composedSchema: unknown,
  classifier: string,
  model: string,
): ClassifierOutput {
  if (!isRecord(raw)) {
    throwInvalid(classifier, model, "fallback must be a JSON object");
  }
  // Fallback is the "no signal" state: only reason and certainty are required.
  // Strip any custom `required` entries beyond those two so that reserved fields
  // and output_schema.required fields don't force the fallback to emit values
  // it cannot meaningfully provide when the classifier has failed.
  const fallbackSchema = isRecord(composedSchema)
    ? { ...composedSchema, required: ["reason", "certainty"] }
    : composedSchema;
  const validate = ajv.compile(fallbackSchema as AnySchema);
  if (!validate(raw)) {
    const message = formatSchemaErrors(validate.errors, "fallback");
    throwInvalid(classifier, model, `fallback is invalid: ${message}`);
  }
  return raw as ClassifierOutput;
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

// ─── Runtime output validation ──────────────────────────────────────────────

export interface ValidateOutputContext {
  readonly classifier: string;
  readonly model: string;
}

export function validateOutputForManifest(
  manifest: RuntimeClassifierManifest,
  value: unknown,
  context: ValidateOutputContext,
): ClassifierOutput {
  if (!isRecord(value)) {
    throwInvalid(context.classifier, context.model, "output must be a JSON object");
  }
  const normalized = normalizeOutput(value, manifest);
  const validate = ajv.compile(manifest.composedOutputSchema as AnySchema);
  if (!validate(normalized)) {
    const message = formatSchemaErrors(validate.errors, "output");
    throwInvalid(context.classifier, context.model, message);
  }
  enforceMutualExclusions(normalized, context.classifier, context.model, "output");
  return truncateReason(normalized) as ClassifierOutput;
}

// Apply small, well-known cleanups that consistently improve LLM compliance:
//   - blank / null routing-style enums → omitted entirely
//   - tools aliases (browser → web, etc.)
function normalizeOutput(
  value: Record<string, unknown>,
  manifest: RuntimeClassifierManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const field of manifest.reservedFields) {
    if (field === "model_tier" || field === "model_specialization") {
      const raw = out[field];
      if (raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
        delete out[field];
      }
    }
    if (field === "tools") {
      const raw = out[field];
      if (Array.isArray(raw)) {
        out[field] = raw.map((item) =>
          typeof item === "string" ? normalizeToolId(item) : item,
        );
      }
    }
  }
  return out;
}

function truncateReason(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.reason !== "string") return value;
  if (value.reason.length <= REASON_MAX_CHARS) return value;
  return { ...value, reason: value.reason.slice(0, REASON_MAX_CHARS).trimEnd() };
}

function enforceMutualExclusions(
  output: Record<string, unknown>,
  classifier: string,
  model: string,
  path: string,
): void {
  for (const group of RESERVED_FIELD_EXCLUSIONS) {
    const present = group.filter((field) => output[field] !== undefined);
    if (present.length > 1) {
      throwInvalid(
        classifier,
        model,
        `${path}: reserved fields are mutually exclusive: ${present.join(", ")}`,
      );
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function compileSchema(
  schema: unknown,
  classifier: string,
  model: string,
  label: string,
): void {
  try {
    ajv.compile(schema as AnySchema);
  } catch (error) {
    throwInvalid(
      classifier,
      model,
      `${label} is invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Format Ajv errors with the offending property name surfaced inline. Ajv's
// default errorsText says "must NOT have additional properties" without
// naming the property, which is unhelpful to debug.
function formatSchemaErrors(
  errors: ReadonlyArray<ErrorObject> | null | undefined,
  dataVar: string,
): string {
  if (!errors || errors.length === 0) return `${dataVar} is invalid`;
  return errors
    .map((err) => {
      const path = `${dataVar}${err.instancePath ?? ""}`;
      if (err.keyword === "additionalProperties") {
        const extra = (err.params as { additionalProperty?: string })?.additionalProperty;
        if (extra) {
          return `${path}.${extra} is not a supported field`;
        }
      }
      if (err.keyword === "required") {
        const missing = (err.params as { missingProperty?: string })?.missingProperty;
        if (missing) {
          return `${path}.${missing} is required`;
        }
      }
      if (err.keyword === "enum") {
        const allowed = (err.params as { allowedValues?: ReadonlyArray<unknown> })?.allowedValues;
        if (allowed) {
          return `${path} has an unsupported value (allowed: ${allowed.join(", ")})`;
        }
      }
      return `${path} ${err.message ?? "is invalid"}`;
    })
    .join("; ");
}
