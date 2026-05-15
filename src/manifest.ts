import type {
  AckReplySignal,
  ClassifierOutput,
  CustomClassifierOutput,
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
    specialization: ModelSpecialization;
    tier: DownstreamModelTier;
  }>;
  readonly constraints_dropped: ReadonlyArray<{
    readonly axis: "specialization" | "tier";
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

export interface Envelope {
  readonly final_reply?: FinalReplySignal;
  readonly ack_reply?: AckReplySignal;
  readonly routing?: RoutingSignal;
  readonly tools?: ToolsSignal;
  readonly prompt_injection?: PromptInjectionSignal;
  readonly custom_outputs: ReadonlyArray<CustomClassifierOutput>;
  readonly model_recommendation: ModelRecommendation;
}

export type ClassifierCustomOutputs = Record<string, unknown>;

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

// Summary of certainty across the run. The aggregator never blocks on these —
// they're reported so the caller can decide whether to act on the route or
// fall back to a safer behavior.
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

export interface PipelineResult {
  readonly action: "route";
  readonly target_message_hash: string;
  readonly downstream: DownstreamPayload;
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: PipelineAudit;
}

export interface AggregatorConfig {
  readonly certaintyThreshold?: number;
  /** @deprecated Use certaintyThreshold. */
  readonly confidenceThreshold?: number;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
