import type {
  DownstreamModelTier,
  ModelSpecialization,
  SecurityDecision,
} from "./enums.js";

export interface StockClassifierMessageInput {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface StockClassifierAttachmentInput {
  readonly id?: string;
  readonly filename?: string;
  readonly mime_type?: string;
  readonly size_bytes?: number;
  readonly text_preview?: string;
  readonly text_truncated?: boolean;
}

export interface StockClassifierInput {
  readonly messages: ReadonlyArray<StockClassifierMessageInput>;
  readonly attachments?: ReadonlyArray<StockClassifierAttachmentInput>;
}

// ─── Stock signal types ─────────────────────────────────────────────────────
//
// Each stock signal is the canonical shape for the corresponding Envelope
// slot. Stock classifier outputs extend their signal with optional reason +
// confidence — those metadata live on the signal itself, not on a separate
// wrapper, so a classifier that has nothing to say doesn't return empty
// reason/confidence metadata about nothing.

export interface FinalReplySignal {
  readonly reply: string;
}

export interface AckReplySignal {
  readonly reply: string;
}

export interface RoutingSignal {
  readonly model_tier?: DownstreamModelTier;
  readonly specialization?: ModelSpecialization;
}

export interface ToolsSignal {
  readonly tools: ReadonlyArray<string>;
}

export interface SafetySignal {
  readonly decision?: SecurityDecision;
  readonly risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  readonly signals: ReadonlyArray<string>;
}

// ─── Per-classifier output types ────────────────────────────────────────────
//
// `reason` (≤120 chars) and `confidence` (0–1) are optional metadata that
// every classifier may attach to its emitted signal. Treat absent confidence
// as 0 in the aggregator.

export interface ClassifierOutputMetadata {
  readonly reason?: string;
  readonly confidence?: number;
}

export interface PreflightClassifierOutput extends ClassifierOutputMetadata {
  readonly final_reply?: FinalReplySignal;
  readonly ack_reply?: AckReplySignal;
}

export type RoutingClassifierOutput = RoutingSignal & ClassifierOutputMetadata;
export type ModelSpecializationClassifierOutput = RoutingSignal & ClassifierOutputMetadata;
export type ToolsClassifierOutput = ToolsSignal & ClassifierOutputMetadata;
export type SecurityClassifierOutput = SafetySignal & ClassifierOutputMetadata;

export interface CustomClassifierOutputValue extends ClassifierOutputMetadata {
  readonly output: unknown;
}

// Discriminated map of stock classifier outputs keyed by classifier name. New
// stock classifiers must be added here and to STOCK_CLASSIFIER_NAMES.
export interface StockClassifierOutputs {
  readonly preflight: PreflightClassifierOutput;
  readonly routing: RoutingClassifierOutput;
  readonly model_specialization: ModelSpecializationClassifierOutput;
  readonly tools: ToolsClassifierOutput;
  readonly security: SecurityClassifierOutput;
}

export const STOCK_CLASSIFIER_NAMES = [
  "preflight",
  "routing",
  "model_specialization",
  "tools",
  "security",
] as const;
export type StockClassifierName = (typeof STOCK_CLASSIFIER_NAMES)[number];

export type StockClassifierOutput =
  StockClassifierOutputs[StockClassifierName];

export type ClassifierOutput = StockClassifierOutput | CustomClassifierOutputValue;

// ─── Manifest types ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  readonly id: string;
  readonly description: string;
}

interface ManifestCommon {
  readonly version: string;
  readonly purpose: string;
  readonly order: number;
  readonly backend?: {
    readonly ollama?: {
      readonly base_model?: string;
    };
  };
}

export interface StockJsonManifest<Name extends StockClassifierName = StockClassifierName>
  extends ManifestCommon {
  readonly kind: "stock";
  readonly name: Name;
  readonly fallback: StockClassifierOutputs[Name];
  readonly tools?: ReadonlyArray<ToolDefinition>;
}

export interface CustomJsonManifest extends ManifestCommon {
  readonly kind: "custom";
  readonly name: string;
  readonly fallback: CustomClassifierOutputValue;
  readonly output_schema: unknown;
}

export type JsonClassifierManifest = StockJsonManifest | CustomJsonManifest;

export interface RuntimeStockManifest<Name extends StockClassifierName = StockClassifierName>
  extends StockJsonManifest<Name> {
  readonly systemPrompt: string;
}

export interface RuntimeCustomManifest extends CustomJsonManifest {
  readonly systemPrompt: string;
}

export type RuntimeClassifierManifest =
  | RuntimeStockManifest
  | RuntimeCustomManifest;

// Helper: narrow a manifest to its stock kind for callers that know the name.
export function isStockManifest(
  manifest: RuntimeClassifierManifest,
): manifest is RuntimeStockManifest {
  return manifest.kind === "stock";
}

export function isCustomManifest(
  manifest: RuntimeClassifierManifest,
): manifest is RuntimeCustomManifest {
  return manifest.kind === "custom";
}

// What the aggregator returns to callers in `classifier_outputs`. Keyed by
// classifier name. `output` is the raw custom value validated against the
// classifier's output_schema.
export interface CustomClassifierOutput {
  readonly classifier: string;
  readonly reason?: string;
  readonly confidence?: number;
  readonly output: unknown;
}
