// Classifier type contracts.
//
// Every classifier — reserved-field-bearing or not — uses the same manifest
// shape and emits the same output envelope: `{ reason, certainty, ...payload }`
// where `payload` may include any subset of the classifier's declared
// reserved fields plus its custom (schema-validated) properties.

import type {
  DownstreamModelTier,
  ModelSpecialization,
  PromptInjectionRiskLevel,
} from "./enums.js";
import type { ReservedFieldName } from "./reserved-fields.js";

export interface ClassifierMessageInput {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ClassifierMessageWindowInput {
  readonly messages: ReadonlyArray<ClassifierMessageInput>;
}

// ─── Envelope signal types (kept for caller-side audit ergonomics) ──────────
//
// The aggregator extracts each reserved field from classifier outputs and
// puts them in named envelope slots. Callers read `audit.routing.model_tier`
// rather than digging through `classifier_outputs.routing.model_tier`, but
// both surfaces carry the same value.

export interface FinalReplySignal {
  readonly text: string;
}

export interface AckReplySignal {
  readonly text: string;
}

export interface RoutingSignal {
  readonly model_tier?: DownstreamModelTier;
  readonly model_specialization?: ModelSpecialization;
}

export interface ToolsSignal {
  readonly tools: ReadonlyArray<string>;
}

export interface PromptInjectionSignal {
  readonly risk_level: PromptInjectionRiskLevel;
}

// ─── Certainty contract ─────────────────────────────────────────────────────

export type Certainty =
  | "no_signal"
  | "very_weak"
  | "weak"
  | "tentative"
  | "reasonable"
  | "strong"
  | "very_strong"
  | "near_certain";

export const CERTAINTY_VALUES = [
  "no_signal",
  "very_weak",
  "weak",
  "tentative",
  "reasonable",
  "strong",
  "very_strong",
  "near_certain",
] as const satisfies readonly Certainty[];

export const certaintyScore: Record<Certainty, number> = {
  no_signal: 0.00,
  very_weak: 0.15,
  weak: 0.30,
  tentative: 0.45,
  reasonable: 0.60,
  strong: 0.75,
  very_strong: 0.88,
  near_certain: 0.97,
};

// ─── Classifier output ──────────────────────────────────────────────────────

export interface ClassifierOutputMetadata {
  readonly reason: string;
  readonly certainty: Certainty;
}

// What every classifier emits: required metadata plus any reserved or custom
// payload fields at the top level. Reserved fields are typed loosely here
// because the manifest decides which subset is present.
export interface ClassifierOutput extends ClassifierOutputMetadata {
  readonly [key: string]: unknown;
}

// ─── Manifest types ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  readonly id: string;
  readonly description: string;
}

// Which side of the conversation a classifier is meant to inspect:
//   - "user"      → runs in classify() only (default)
//   - "assistant" → runs in inspect() only
//   - "both"      → runs in both
export type AppliesTo = "user" | "assistant" | "both";

export const APPLIES_TO_VALUES = ["user", "assistant", "both"] as const satisfies readonly AppliesTo[];

export interface JsonClassifierManifest {
  readonly name: string;
  readonly version: string;
  readonly purpose: string;
  // Worker-pool dispatch priority — lower runs first; same value runs adjacent.
  // Optional: classifiers without a value sort last (treated as +Infinity).
  readonly dispatch_order?: number;
  readonly applies_to?: AppliesTo;
  readonly reserved_fields?: ReadonlyArray<ReservedFieldName>;
  readonly allowed_tools?: ReadonlyArray<ToolDefinition>;
  readonly output_schema?: unknown;
  readonly fallback: ClassifierOutput;
  readonly backend?: {
    readonly ollama?: {
      readonly base_model?: string;
    };
  };
}

export interface RuntimeClassifierManifest extends JsonClassifierManifest {
  readonly systemPrompt: string;
  // The composed JSON Schema actually used to validate model outputs at
  // runtime. Built once at load time by merging the manifest's custom
  // `output_schema.properties` with canonical sub-schemas for each declared
  // reserved field, plus `reason` / `certainty`.
  readonly composedOutputSchema: unknown;
  readonly reservedFields: ReadonlyArray<ReservedFieldName>;
  // Always populated; defaults to "user" when the manifest omits applies_to.
  readonly appliesTo: AppliesTo;
}

// What the audit envelope surfaces for each classifier — the full output
// (reason + certainty + reserved + custom fields) plus the classifier name.
export interface ClassifierAuditOutput extends ClassifierOutput {
  readonly classifier: string;
}
