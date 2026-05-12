import type {
  DownstreamExecutionMode,
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

export type HandoffSignal =
  | { readonly kind: "route"; readonly ack_reply?: string }
  | { readonly kind: "final"; readonly reply: string }
  | { readonly kind: "block"; readonly reason_code?: string };

export interface RoutingSignal {
  readonly execution_mode?: DownstreamExecutionMode;
  readonly model_tier?: DownstreamModelTier;
  readonly specialization?: ModelSpecialization;
}

export type ContextSignal =
  | { readonly status: "standalone" }
  | { readonly status: "sufficient"; readonly include_prior_messages: number }
  | { readonly status: "insufficient" }
  | { readonly status: "unknown" };

export interface ToolsSignal {
  readonly required: boolean;
  readonly families: ReadonlyArray<string>;
}

export interface ResponseSignal {
  readonly language?: string;
  readonly locale?: string;
}

export interface SafetySignal {
  readonly decision?: SecurityDecision;
  readonly risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  readonly signals: ReadonlyArray<string>;
}

export interface SummarySignal {
  readonly target_message?: string;
  readonly conversation_window?: string;
}

export interface StockClassifierOutput {
  readonly reason: string;
  readonly confidence: number;
  readonly handoff?: HandoffSignal;
  readonly routing?: RoutingSignal;
  readonly context?: ContextSignal;
  readonly tools?: ToolsSignal;
  readonly response?: ResponseSignal;
  readonly safety?: SafetySignal;
  readonly summary?: SummarySignal;
  readonly output?: unknown;
}

export const STOCK_SIGNAL_KEYS = [
  "handoff",
  "routing",
  "context",
  "tools",
  "response",
  "safety",
  "summary",
  "output",
] as const;
export type StockSignalKey = (typeof STOCK_SIGNAL_KEYS)[number];

export type StockSignalEmits = Partial<Record<StockSignalKey, boolean>>;

export interface ToolFamilyDefinition {
  readonly id: string;
  readonly description: string;
}

export interface JsonClassifierManifest {
  readonly name: string;
  readonly version: string;
  readonly purpose: string;
  readonly order: number;
  readonly emits: StockSignalEmits;
  readonly fallback: StockClassifierOutput;
  readonly short_circuit?: {
    readonly priority: number;
    readonly kinds?: ReadonlyArray<HandoffSignal["kind"]>;
    readonly safety_decisions?: ReadonlyArray<NonNullable<SafetySignal["decision"]>>;
  };
  readonly tool_families?: ReadonlyArray<ToolFamilyDefinition>;
  readonly output_schema?: unknown;
  readonly backend?: {
    readonly ollama?: {
      readonly base_model?: string;
      readonly adapter_model?: string;
    };
  };
  readonly ui?: {
    readonly label?: string;
    readonly renderer?: "enum" | "list" | "object" | "boolean";
  };
}

export interface RuntimeClassifierManifest extends JsonClassifierManifest {
  readonly systemPrompt: string;
}

export interface CustomClassifierOutput {
  readonly classifier: string;
  readonly reason: string;
  readonly confidence: number;
  readonly output: unknown;
}
