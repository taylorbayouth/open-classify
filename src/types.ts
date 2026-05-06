import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  ModelSpecialization,
  SecurityRiskLevel,
  SecuritySignal,
  Terminality,
  ToolFamily,
} from "./enums.js";

export type ConcreteDownstreamModelTier = Exclude<
  DownstreamModelTier,
  "unable_to_determine"
>;
export type ConcreteModelSpecialization = Exclude<ModelSpecialization, "unclear">;
export type DownstreamModelConfigKey =
  | `${ConcreteModelSpecialization}.${ConcreteDownstreamModelTier}`
  | ConcreteDownstreamModelTier
  | ConcreteModelSpecialization
  | "default";
export type DownstreamModelConfig = Partial<Record<DownstreamModelConfigKey, string>>;

export type ConversationMessageRole = "user" | "assistant";

export interface AttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
}

export interface ConversationMessageInput {
  role?: ConversationMessageRole;
  text: string;
}

export interface OpenClassifyInput {
  /**
   * Chronological message history ending with the message to classify.
   *
   * Callers should send the context they already have. Open Classify classifies
   * only the final message and uses earlier messages as context. Normalization
   * walks backward from the final message, keeps newest whole context messages
   * while the classifier payload budget allows, and caps the retained history to
   * 20 messages. It never slices message text.
   */
  messages: ConversationMessageInput[];
  attachments?: AttachmentInput[];
}

export interface NormalizedOpenClassifyInput {
  messages: ConversationMessageInput[];
  text: string;
  attachments: AttachmentInput[];
  target_message_hash: string;
}

export interface ClassifierAttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
}

export interface ClassifierInput {
  text: string;
  messages: ConversationMessageInput[];
  attachments: ClassifierAttachmentInput[];
  target_message_hash: string;
}

export interface PreflightResult {
  terminality: Terminality;
  reply: string;
  reason: string;
}

export interface RoutingResult {
  execution_mode: DownstreamExecutionMode;
  model_tier: DownstreamModelTier;
  reason: string;
}

export interface ConversationHistoryResult {
  is_standalone: boolean;
  refers_to_history: boolean;
  relevant_conversation_history: ConversationMessageInput[];
  needs_unseen_history: boolean;
  reason: string;
}

export interface MemoryRetrievalQueriesResult {
  queries: string[];
  reason: string;
}

export interface ToolsResult {
  needed: boolean;
  families: ToolFamily[];
  reason: string;
}

export interface ModelSpecializationResult {
  model_specialization: ModelSpecialization;
  reason: string;
}

export interface SecurityResult {
  risk_level: SecurityRiskLevel;
  signals: SecuritySignal[];
  reason: string;
}

export interface OpenClassifyResult {
  preflight: PreflightResult;
  routing: RoutingResult;
  conversation_history: ConversationHistoryResult;
  memory_retrieval_queries: MemoryRetrievalQueriesResult;
  tools: ToolsResult;
  model_specialization: ModelSpecializationResult;
  security: SecurityResult;
}

export interface OpenClassifyModelRecommendation {
  key: DownstreamModelConfigKey;
  model: string | null;
  resolved_from: DownstreamModelConfigKey | null;
  tier: DownstreamModelTier;
  specialization: ModelSpecialization;
}

export interface OpenClassifyHandoff {
  execution_mode: DownstreamExecutionMode;
  model: OpenClassifyModelRecommendation;
  context: {
    conversation: {
      prior_messages_needed: number;
      messages: ConversationMessageInput[];
      needs_unseen_history: boolean;
    };
    memory: {
      queries: string[];
    };
    tools: {
      needed: boolean;
      families: ToolFamily[];
    };
  };
  safety: {
    risk_level: SecurityRiskLevel;
    signals: SecuritySignal[];
  };
}

export type ClassifierName = keyof OpenClassifyResult;

export type ClassifierOutput<Name extends ClassifierName> = OpenClassifyResult[Name];

export type RunClassifier = <Name extends ClassifierName>(
  name: Name,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput<Name>>;

export type ClassifierFallbackReason = "error" | "timeout";

export interface ClassifierRunStatus {
  ok: boolean;
  source: "model" | "fallback";
  attempts: number;
  reason?: ClassifierFallbackReason;
  error?: string;
}

export type ClassifierRunStatusMap = Partial<Record<ClassifierName, ClassifierRunStatus>>;

export interface OpenClassifyTerminalPipelineResult {
  stop_downstream: true;
  decision: "terminal";
  target_message_hash: string;
  reply: string;
  preflight: PreflightResult;
  classifier_status: ClassifierRunStatusMap;
}

export interface OpenClassifyBlockPipelineResult {
  stop_downstream: true;
  decision: "block";
  target_message_hash: string;
  reply: string;
  preflight: PreflightResult;
  security: SecurityResult;
  classifier_status: ClassifierRunStatusMap;
}

export interface OpenClassifyRoutePipelineResult {
  stop_downstream: false;
  decision: "route";
  target_message_hash: string;
  reply: string;
  handoff: OpenClassifyHandoff;
  classifiers: OpenClassifyResult;
  classifier_status: ClassifierRunStatusMap;
}

export type OpenClassifyPipelineResult =
  | OpenClassifyTerminalPipelineResult
  | OpenClassifyBlockPipelineResult
  | OpenClassifyRoutePipelineResult;
