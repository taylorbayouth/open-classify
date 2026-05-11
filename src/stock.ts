import type {
  ConcreteDownstreamExecutionMode,
  ConcreteDownstreamModelTier,
  ConcreteModelSpecialization,
} from "./manifest.js";

export const HISTORY_OLDER_MESSAGES_VALUES = [
  "none",
  "available",
  "unknown",
] as const;
export type HistoryOlderMessages = (typeof HISTORY_OLDER_MESSAGES_VALUES)[number];

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
  readonly history?: {
    readonly older_messages?: HistoryOlderMessages;
  };
  readonly attachments?: ReadonlyArray<StockClassifierAttachmentInput>;
}

export type HandoffSignal =
  | { readonly kind: "route"; readonly ack_reply?: string }
  | { readonly kind: "final"; readonly reply: string }
  | { readonly kind: "block"; readonly reason_code?: string };

export interface RoutingSignal {
  readonly execution_mode?: ConcreteDownstreamExecutionMode;
  readonly model_tier?: ConcreteDownstreamModelTier;
  readonly specialization?: ConcreteModelSpecialization;
}

export type ContextSignal =
  | { readonly status: "standalone" }
  | { readonly status: "sufficient"; readonly include_prior_messages: number }
  | { readonly status: "insufficient" }
  | { readonly status: "unknown" };

export interface ToolsSignal<TToolFamily extends string = string> {
  readonly required: boolean;
  readonly families: ReadonlyArray<TToolFamily>;
}

export interface ResponseSignal {
  readonly language?: string;
  readonly locale?: string;
}

export interface SafetySignal<TSafetySignal extends string = string> {
  readonly risk_level: "normal" | "suspicious" | "high_risk" | "unknown";
  readonly signals: ReadonlyArray<TSafetySignal>;
}

export interface SummarySignal {
  readonly target_message?: string;
  readonly conversation_window?: string;
}

export interface StockClassifierOutput<
  TCustom = unknown,
  TToolFamily extends string = string,
  TSafetySignal extends string = string,
> {
  readonly reason: string;
  readonly confidence: number;
  readonly handoff?: HandoffSignal;
  readonly routing?: RoutingSignal;
  readonly context?: ContextSignal;
  readonly tools?: ToolsSignal<TToolFamily>;
  readonly response?: ResponseSignal;
  readonly safety?: SafetySignal<TSafetySignal>;
  readonly summary?: SummarySignal;
  readonly output?: TCustom;
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
    readonly kinds: ReadonlyArray<HandoffSignal["kind"]>;
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
