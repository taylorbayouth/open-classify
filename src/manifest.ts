import type {
  AckReplySignal,
  ClassifierOutput,
  CustomClassifierOutput,
  FinalReplySignal,
  RoutingSignal,
  RuntimeClassifierManifest,
  SafetySignal,
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
export const CERTAINTY_GATE_MODES = [
  "min_score",
  "avg_score",
  "off",
] as const;
export type CertaintyGateMode = (typeof CERTAINTY_GATE_MODES)[number];

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
  readonly safety?: SafetySignal;
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

export interface PipelineMeta {
  readonly classifiers: Record<string, ClassifierEntry>;
}

export interface PipelineAudit extends Envelope {
  readonly meta: PipelineMeta;
  readonly fired_by?: string;
  readonly certainty_gate?: LowCertaintyBlockReason;
}

export type BlockReason =
  | SecurityBlockReason
  | LowCertaintyBlockReason;

export interface SecurityBlockReason {
  readonly kind: "security";
  readonly risk_level: SafetySignal["risk_level"];
  readonly signals: ReadonlyArray<string>;
}

export interface LowCertaintyBlockReason {
  readonly kind: "low_certainty";
  readonly mode: Exclude<CertaintyGateMode, "off">;
  readonly threshold: number;
  readonly score: number;
  readonly classifier_scores: Readonly<Record<string, number>>;
  readonly low_classifiers: ReadonlyArray<string>;
}

export type ReplyPipelineResult = {
  readonly action: "reply";
  readonly message_id: string;
  readonly reply: {
    readonly text: string;
  };
  readonly reason: "preflight_reply";
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: Pick<PipelineAudit, "final_reply" | "meta" | "fired_by">;
};

export type BlockPipelineResult = {
  readonly action: "block";
  readonly message_id: string;
  readonly fired_by?: string;
  readonly reason: BlockReason;
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: Pick<PipelineAudit, "safety" | "meta" | "fired_by" | "certainty_gate">;
};

export type RoutePipelineResult = {
  readonly action: "route";
  readonly message_id: string;
  readonly downstream: DownstreamPayload;
  readonly classifier_outputs: ClassifierCustomOutputs;
  readonly audit: PipelineAudit;
};

export type PipelineResult =
  | ReplyPipelineResult
  | BlockPipelineResult
  | RoutePipelineResult;

export interface AggregatorConfig {
  readonly certaintyThreshold?: number;
  /** @deprecated Use certaintyThreshold. */
  readonly confidenceThreshold?: number;
  readonly certaintyGate?: CertaintyGateMode;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
