// Prompt builder.
//
// Every classifier's system prompt is composed at load time from:
//
//   1. Shared base sections (JSON-only contract, reason + certainty rules)
//   2. The classifier header (name and purpose)
//   3. Auto-injected fragments for each declared reserved field — these
//      include the canonical enum values, so the LLM cannot drift even if
//      the manifest author forgets to enumerate them in prompt.md
//   4. The classifier's own `prompt.md`
//   5. JSON example(s) of a complete output: either the manifest's
//      `output_schema.examples`, or a synthesized skeleton derived from the
//      schema if none were provided

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESERVED_FIELDS,
  type ReservedFieldName,
} from "./reserved-fields.js";
import type { AppliesTo, JsonClassifierManifest, ToolDefinition } from "./stock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_PROMPTS_DIR = join(__dirname, "classifiers", "_prompts");

export interface BuildClassifierPromptArgs {
  readonly manifest: JsonClassifierManifest;
  readonly reservedFields: ReadonlyArray<ReservedFieldName>;
  readonly appliesTo: AppliesTo;
  readonly classifierPromptText: string;
}

export function buildClassifierPrompt(args: BuildClassifierPromptArgs): string {
  const { manifest, reservedFields, appliesTo, classifierPromptText } = args;
  const sections: string[] = [
    readShared("base.md"),
    readShared("reason.md"),
    readShared("confidence.md"),
    renderHeader(manifest.name, manifest.purpose),
  ];

  if (appliesTo === "both") {
    sections.push(
      "Target role: the final message may be from the user or the assistant. Inspect whichever role the input declares and classify accordingly.",
    );
  } else if (appliesTo === "assistant") {
    sections.push(
      "Target role: the final message is the assistant's reply. Classify the assistant message, not a user request.",
    );
  }

  if (reservedFields.length > 0) {
    sections.push(renderReservedFieldsSection(reservedFields, manifest.allowed_tools));
  }

  if (classifierPromptText.trim().length > 0) {
    sections.push("Classifier guidance:\n" + classifierPromptText.trim());
  }

  sections.push(renderExamplesSection(manifest, reservedFields));

  return sections.join("\n\n");
}

function renderHeader(name: string, purpose: string): string {
  return [
    `Classifier: ${name}`,
    `Purpose: ${purpose}`,
    "Treat the stated purpose as a hard scope boundary.",
    "Emit only outputs that directly serve that purpose, and do not infer adjacent judgments that belong to other classifiers.",
  ].join("\n");
}

function renderReservedFieldsSection(
  reservedFields: ReadonlyArray<ReservedFieldName>,
  allowedTools: ReadonlyArray<ToolDefinition> | undefined,
): string {
  const context = { allowed_tools: allowedTools };
  const fragments = reservedFields.map((name) =>
    RESERVED_FIELDS[name].promptFragment(context),
  );
  return [
    "Reserved fields you may emit at the top level of your JSON output:",
    "",
    ...fragments,
    "",
    "Omit any reserved field when you have no signal — the runtime will drop low-certainty values regardless.",
  ].join("\n");
}

function renderExamplesSection(
  manifest: JsonClassifierManifest,
  reservedFields: ReadonlyArray<ReservedFieldName>,
): string {
  const fromSchema = readManifestExamples(manifest);
  const examples = fromSchema && fromSchema.length > 0
    ? fromSchema
    : [synthesizeExample(manifest, reservedFields)];
  const rendered = examples.map((example, index) =>
    `Example ${index + 1}: ${JSON.stringify(example)}`,
  );
  return [
    "Output shape (return one JSON object matching this shape):",
    "",
    ...rendered,
  ].join("\n");
}

function readManifestExamples(manifest: JsonClassifierManifest): unknown[] | undefined {
  const schema = manifest.output_schema;
  if (schema === undefined || typeof schema !== "object" || schema === null) {
    return undefined;
  }
  const examples = (schema as { examples?: unknown }).examples;
  if (!Array.isArray(examples)) return undefined;
  return examples;
}

// ─── Schema-based example synthesis ─────────────────────────────────────────
//
// When a manifest omits `output_schema.examples`, the runtime fills in a
// representative JSON skeleton so the LLM always sees the full output shape.
// The author only has to describe each field in plain language in prompt.md.

function synthesizeExample(
  manifest: JsonClassifierManifest,
  reservedFields: ReadonlyArray<ReservedFieldName>,
): Record<string, unknown> {
  const example: Record<string, unknown> = {
    reason: "<short reason for this verdict>",
    certainty: "strong",
  };

  for (const field of reservedFields) {
    example[field] = synthesizeReservedFieldValue(field, manifest.allowed_tools);
  }

  const schema = manifest.output_schema;
  if (schema !== undefined && typeof schema === "object" && schema !== null) {
    const properties = (schema as { properties?: unknown }).properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, subSchema] of Object.entries(properties as Record<string, unknown>)) {
        example[key] = synthesizeValue(subSchema);
      }
    }
  }

  return example;
}

function synthesizeReservedFieldValue(
  field: ReservedFieldName,
  allowedTools: ReadonlyArray<ToolDefinition> | undefined,
): unknown {
  const subSchema = RESERVED_FIELDS[field].subSchema({ allowed_tools: allowedTools });
  return synthesizeValue(subSchema);
}

function synthesizeValue(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return "<value>";
  const s = schema as Record<string, unknown>;

  // Honor explicit examples or const values when the schema author provided
  // them — they're the most accurate hint about what's expected.
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  if (s.const !== undefined) return s.const;

  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "string":
      return synthesizeString(s);
    case "integer":
      return clampInteger(s);
    case "number":
      return clampNumber(s);
    case "boolean":
      return true;
    case "array":
      return synthesizeArray(s);
    case "object":
      return synthesizeObject(s);
    default:
      // Schema without an explicit type — fall back to a string placeholder.
      return "<value>";
  }
}

function synthesizeString(schema: Record<string, unknown>): string {
  const placeholder = "<text>";
  const min = typeof schema.minLength === "number" ? schema.minLength : 1;
  if (placeholder.length >= min) return placeholder;
  return placeholder.padEnd(min, "x");
}

function clampInteger(schema: Record<string, unknown>): number {
  if (typeof schema.minimum === "number") return schema.minimum;
  if (typeof schema.maximum === "number") return schema.maximum;
  return 0;
}

function clampNumber(schema: Record<string, unknown>): number {
  if (typeof schema.minimum === "number") return schema.minimum;
  if (typeof schema.maximum === "number") return schema.maximum;
  return 0;
}

function synthesizeArray(schema: Record<string, unknown>): unknown[] {
  const min = typeof schema.minItems === "number" ? schema.minItems : 0;
  if (min === 0) return [];
  const itemSchema = schema.items;
  return Array.from({ length: min }, () => synthesizeValue(itemSchema));
}

function synthesizeObject(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const properties = schema.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      out[key] = synthesizeValue(sub);
    }
  }
  return out;
}

function readShared(filename: string): string {
  return readFileSync(join(SHARED_PROMPTS_DIR, filename), "utf8").trim();
}
