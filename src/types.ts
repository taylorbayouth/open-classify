import type {
  ContextSufficiency,
  DownstreamExecutionMode,
  DownstreamModelTier,
  SecurityPosture,
  SecuritySignal,
  Terminality,
  ToolFamily,
} from "./enums.js";

export type ConversationMessageRole = "user" | "assistant";

export interface AttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
  raw?: Record<string, unknown>;
}

export interface ConversationMessageInput {
  role?: ConversationMessageRole;
  text: string;
  message_id?: string;
  timestamp?: string;
  raw?: Record<string, unknown>;
}

export interface OpenClassifyInput {
  /**
   * Chronological conversation slice ending with the message to classify.
   *
   * Callers should send the best same-thread/same-conversation context they
   * already have. Open Classify classifies only the final message and uses
   * earlier messages as context. Normalization walks backward from the final
   * message, keeps newest whole context messages while the classifier payload
   * budget allows, and caps the retained window to 20 messages. It never slices
   * message text.
   */
  conversation_window: ConversationMessageInput[];
  external_request_id?: string;
  source?: string;
  conversation_id?: string;
  thread_id?: string;
  raw?: Record<string, unknown>;
  attachments?: AttachmentInput[];
}

export interface NormalizedOpenClassifyInput extends OpenClassifyInput {
  conversation_window: ConversationMessageInput[];
  text: string;
  attachments: AttachmentInput[];
  message_hash: string;
  request_hash: string;
}

export interface ClassifierAttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
}

export interface ClassifierInput {
  text: string;
  conversation_window: ConversationMessageInput[];
  attachments: ClassifierAttachmentInput[];
  message_hash: string;
  request_hash: string;
  external_request_id?: string;
  source?: string;
  conversation_id?: string;
  thread_id?: string;
}

export interface PreflightResult {
  terminality: Terminality;
  awk: string;
}

export interface DownstreamRouteResult {
  execution_mode: DownstreamExecutionMode;
  model_tier: DownstreamModelTier;
}

export interface ContextSufficiencyResult {
  value: ContextSufficiency;
  missing_context: string[];
  relevant_context_summary: string;
}

export interface MemoryRetrievalQueriesResult {
  queries: string[];
}

export interface ToolFamilyNeedResult {
  value: ToolFamily[];
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

export interface SecurityPostureResult {
  value: SecurityPosture;
  signals: SecuritySignal[];
  notes: string;
}

export interface OpenClassifyResult {
  preflight: PreflightResult;
  downstream_route: DownstreamRouteResult;
  context_sufficiency: ContextSufficiencyResult;
  memory_retrieval_queries: MemoryRetrievalQueriesResult;
  tool_family_need: ToolFamilyNeedResult;
  message_and_attachment_digest: MessageAndAttachmentDigestResult;
  security_posture: SecurityPostureResult;
}

export type ClassifierName = keyof OpenClassifyResult;

export type ClassifierOutput<Name extends ClassifierName> = OpenClassifyResult[Name];

export type RunClassifier = <Name extends ClassifierName>(
  name: Name,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput<Name>>;

export interface OpenClassifyTerminalPipelineResult {
  status: "terminal";
  request: NormalizedOpenClassifyInput;
  preflight: PreflightResult;
}

export interface OpenClassifyContinuePipelineResult {
  status: "continue";
  request: NormalizedOpenClassifyInput;
  awk: string;
  classifiers: OpenClassifyResult;
}

export type OpenClassifyPipelineResult =
  | OpenClassifyTerminalPipelineResult
  | OpenClassifyContinuePipelineResult;
