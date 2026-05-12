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
  ConversationMessageInput,
} from "./types.js";
import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  ModelSpecialization,
} from "./enums.js";

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
  readonly specializations: ReadonlyArray<ModelSpecialization>;
  readonly execution_modes: ReadonlyArray<DownstreamExecutionMode>;
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
    execution_mode: DownstreamExecutionMode;
    tier: DownstreamModelTier;
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
  readonly params_in_billions: number | null;
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

export type ClassifierCustomOutputs = Record<string, unknown>;

export interface DownstreamTargetMessage {
  readonly role: "user";
  readonly text: string;
  readonly hash: string;
  readonly summary?: string;
}

export interface DownstreamPayload {
  readonly model_id: string;
  readonly messages: ReadonlyArray<ConversationMessageInput>;
  readonly target_message: DownstreamTargetMessage;
  readonly tools: ToolsSignal;
  readonly context?: ContextSignal;
  readonly context_summary?: string;
  readonly attachments: ClassifierInput["attachments"];
}

export type ClassifierEntry = StockClassifierOutput & {
  readonly status: ClassifierRunStatus;
  readonly version: string;
};

export interface PipelineMeta {
  readonly classifiers: Record<string, ClassifierEntry>;
}

export interface PipelineAudit extends Envelope {
  readonly meta: PipelineMeta;
  readonly fired_by?: string;
}

export type AnswerPipelineResult = {
  readonly action: "answer";
  readonly message_id: string;
  readonly reply: string;
  readonly reason: "already_answered";
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: Pick<PipelineAudit, "handoff" | "meta" | "fired_by">;
};

export type BlockPipelineResult = {
  readonly action: "block";
  readonly message_id: string;
  readonly reason: {
    readonly code?: string;
    readonly risk_level?: SafetySignal["risk_level"];
    readonly signals?: ReadonlyArray<string>;
  };
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: Pick<PipelineAudit, "handoff" | "safety" | "meta" | "fired_by">;
};

export type NeedsReviewPipelineResult = {
  readonly action: "needs_review";
  readonly message_id: string;
  readonly fired_by: string;
  readonly reason: {
    readonly risk_level?: SafetySignal["risk_level"];
    readonly signals?: ReadonlyArray<string>;
  };
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: Pick<PipelineAudit, "safety" | "meta" | "fired_by">;
};

export type RoutePipelineResult = {
  readonly action: "route";
  readonly message_id: string;
  readonly downstream: DownstreamPayload;
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: PipelineAudit;
};

export type PipelineResult =
  | AnswerPipelineResult
  | BlockPipelineResult
  | NeedsReviewPipelineResult
  | RoutePipelineResult;

export interface AggregatorConfig {
  readonly confidenceThreshold?: number;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
