import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  SecurityRiskLevel,
  SecuritySignal,
  Terminality,
  ToolFamily,
} from "./enums.js";

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
}

export interface RoutingResult {
  execution_mode: DownstreamExecutionMode;
  model_tier: DownstreamModelTier;
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
}

export interface ToolsResult {
  needed: boolean;
  families: ToolFamily[];
}

export interface AttachmentDigest {
  filename: string;
  size_bytes?: number;
  mime_type?: string;
  summary: string;
}

export interface MessageAndAttachmentDigestResult {
  slug: string;
  summary: string;
  attachments: AttachmentDigest[];
}

export interface SecurityResult {
  risk_level: SecurityRiskLevel;
  signals: SecuritySignal[];
  notes: string;
}

export interface OpenClassifyResult {
  preflight: PreflightResult;
  routing: RoutingResult;
  conversation_history: ConversationHistoryResult;
  memory_retrieval_queries: MemoryRetrievalQueriesResult;
  tools: ToolsResult;
  message_and_attachment_digest: MessageAndAttachmentDigestResult;
  security: SecurityResult;
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
  classifiers: OpenClassifyResult;
  classifier_status: ClassifierRunStatusMap;
}

export type OpenClassifyPipelineResult =
  | OpenClassifyTerminalPipelineResult
  | OpenClassifyBlockPipelineResult
  | OpenClassifyRoutePipelineResult;
