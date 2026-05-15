import type {
  AckReplySignal,
  ClassifierAuditOutput,
  ClassifierOutput,
  FinalReplySignal,
  PromptInjectionSignal,
  RoutingSignal,
  RuntimeClassifierManifest,
  ToolsSignal,
} from "./stock.js";
import type {
  ClassifierInput,
  ClassifierRunStatus,
} from "./types.js";
import type {
  DownstreamModelTier,
  ModelSpecialization,
} from "./enums.js";

export type ClassifierName = string;
export type ClassifierResults = Record<ClassifierName, ClassifierOutput>;

export type RunClassifier = (
  name: ClassifierName,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput>;

export interface CatalogEntry {
  readonly id: string;
  readonly specializations: ReadonlyArray<ModelSpecialization>;
  readonly tier: DownstreamModelTier;
  readonly params_in_billions: number | null;
  readonly context_window: number;
  readonly input_tokens_cpm?: number;
  readonly cached_tokens_cpm?: number;
  readonly output_tokens_cpm?: number;
}

export interface Catalog {
  readonly models: ReadonlyArray<CatalogEntry>;
  readonly default: string;
}

export interface ModelRecommendationResolution {
  readonly constraints_used: Partial<{
    model_specialization: ModelSpecialization;
    model_tier: DownstreamModelTier;
  }>;
  readonly constraints_dropped: ReadonlyArray<{
    readonly axis: "model_specialization" | "model_tier";
    readonly reason: "low_confidence" | "no_match_relaxed" | "default_fallback";
  }>;
  readonly confidences: Partial<{
    routing: number;
  }>;
  readonly fell_back_to_default: boolean;
}

export interface ModelRecommendation {
  readonly id: string;
  readonly params_in_billions: number | null;
  readonly context_window: number;
  readonly input_tokens_cpm?: number;
  readonly cached_tokens_cpm?: number;
  readonly output_tokens_cpm?: number;
  readonly resolution: ModelRecommendationResolution;
}

// Audit envelope. Reserved fields are surfaced in named slots for caller
// ergonomics; the same data is also available in `classifier_outputs[]`
// alongside non-reserved (custom) fields.
export interface Envelope {
  readonly final_reply?: FinalReplySignal;
  readonly ack_reply?: AckReplySignal;
  readonly routing?: RoutingSignal;
  readonly tools?: ToolsSignal;
  readonly prompt_injection?: PromptInjectionSignal;
  readonly classifier_outputs: ReadonlyArray<ClassifierAuditOutput>;
  readonly model_recommendation: ModelRecommendation;
}

// Public flat map keyed by classifier name. Each value is the full validated
// output with `reason` and `certainty` stripped — what callers usually want
// when reading downstream classifier signals.
export type ClassifierPublicOutputs = Record<string, Record<string, unknown>>;

export interface DownstreamTargetMessage {
  readonly role: "user";
  readonly text: string;
  readonly hash: string;
}

export interface DownstreamPayload {
  readonly model_id: string;
  readonly target_message: DownstreamTargetMessage;
  readonly tools: ToolsSignal;
}

export type ClassifierEntry = ClassifierOutput & {
  readonly status: ClassifierRunStatus;
  readonly version: string;
};

export interface CertaintySummary {
  readonly min: number;
  readonly avg: number;
}

export interface PipelineMeta {
  readonly classifiers: Record<string, ClassifierEntry>;
  readonly certainty: CertaintySummary;
}

export interface PipelineAudit extends Envelope {
  readonly meta: PipelineMeta;
}

// Result of inspect() — the assistant-side pass. Lean by design: no
// downstream routing, no audit envelope. Callers use it for lightweight
// post-hoc transforms (slugs, summaries) and any "both"-tagged classifiers
// (e.g. prompt_injection) that should also run on the assistant reply.
export interface InspectResult {
  readonly target_message_hash: string;
  readonly classifier_outputs: ClassifierPublicOutputs;
}

export interface PipelineResult {
  readonly action: "route";
  readonly target_message_hash: string;
  readonly downstream: DownstreamPayload;
  readonly classifier_outputs: ClassifierPublicOutputs;
  readonly audit: PipelineAudit;
}

export interface AggregatorConfig {
  readonly certaintyThreshold?: number;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
