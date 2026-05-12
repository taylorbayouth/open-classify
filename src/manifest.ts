import type {
  CustomClassifierOutput,
  HandoffSignal,
  ResponseSignal,
  RoutingSignal,
  SafetySignal,
  StockClassifierOutput,
  SummarySignal,
  ToolsSignal,
  ContextSignal,
  RuntimeClassifierManifest,
} from "./stock.js";
import type {
  ClassifierInput,
  ClassifierRunStatus,
} from "./types.js";
import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  ModelSpecialization,
} from "./enums.js";

export type ConcreteDownstreamModelTier = Exclude<
  DownstreamModelTier,
  "unable_to_determine"
>;
export type ConcreteModelSpecialization = Exclude<ModelSpecialization, "unclear">;
export type ConcreteDownstreamExecutionMode = Exclude<
  DownstreamExecutionMode,
  "unable_to_determine"
>;

export type ClassifierResultBase = Pick<StockClassifierOutput, "reason" | "confidence">;
export type ClassifierName = string;
export type ClassifierResults = Record<ClassifierName, StockClassifierOutput>;
export type RunClassifier = (
  name: ClassifierName,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<StockClassifierOutput>;

export interface CatalogEntry {
  readonly id: string;
  readonly specializations: ReadonlyArray<ConcreteModelSpecialization>;
  readonly execution_modes: ReadonlyArray<ConcreteDownstreamExecutionMode>;
  readonly tier: ConcreteDownstreamModelTier;
  readonly params_in_billions: number;
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
    specialization: ConcreteModelSpecialization;
    execution_mode: ConcreteDownstreamExecutionMode;
    tier: ConcreteDownstreamModelTier;
  }>;
  readonly constraints_dropped: ReadonlyArray<{
    readonly axis: "specialization" | "execution_mode" | "tier";
    readonly reason:
      | "low_confidence"
      | "escape_hatch"
      | "no_match_relaxed"
      | "default_fallback";
  }>;
  readonly confidences: Partial<{
    routing: number;
  }>;
  readonly fell_back_to_default: boolean;
}

export interface ModelRecommendation {
  readonly id: string;
  readonly params_in_billions: number;
  readonly context_window: number;
  readonly input_tokens_cpm?: number;
  readonly cached_tokens_cpm?: number;
  readonly output_tokens_cpm?: number;
  readonly resolution: ModelRecommendationResolution;
}

export interface Envelope {
  readonly handoff?: HandoffSignal;
  readonly routing?: RoutingSignal;
  readonly context?: ContextSignal;
  readonly tools?: ToolsSignal;
  readonly response?: ResponseSignal;
  readonly safety?: SafetySignal;
  readonly summary?: SummarySignal;
  readonly custom_outputs: ReadonlyArray<CustomClassifierOutput>;
  readonly model_recommendation: ModelRecommendation;
}

export type ClassifierEntry = StockClassifierOutput & {
  readonly status: ClassifierRunStatus;
  readonly version: string;
};

export interface PipelineMeta {
  readonly classifiers: Record<string, ClassifierEntry>;
}

export type ShortCircuitPipelineResult = {
  readonly decision: "short_circuit";
  readonly target_message_hash: string;
  readonly fired_by: string;
  readonly handoff?: HandoffSignal;
  readonly safety?: SafetySignal;
  readonly meta: PipelineMeta;
} & (
  | { readonly kind: "final"; readonly reply: string }
  | { readonly kind: "block" }
);

export type NeedsReviewPipelineResult = {
  readonly decision: "needs_review";
  readonly target_message_hash: string;
  readonly fired_by: string;
  readonly safety?: SafetySignal;
  readonly meta: PipelineMeta;
};

export type RoutePipelineResult = {
  readonly decision: "route";
  readonly target_message_hash: string;
  readonly meta: PipelineMeta;
} & Envelope;

export type PipelineResult =
  | ShortCircuitPipelineResult
  | NeedsReviewPipelineResult
  | RoutePipelineResult;

export interface AggregatorConfig {
  readonly confidenceThreshold?: number;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
