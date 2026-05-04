import type {
  AdditionalHistoryNeed,
  DownstreamRoute,
  SecurityPosture,
  SecuritySignal,
  Terminality,
  ToolFamily,
} from "./enums.js";

export interface AttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
  raw?: Record<string, unknown>;
}

export interface OpenClassifyInput {
  text: string;
  external_request_id?: string;
  source?: string;
  conversation_id?: string;
  thread_id?: string;
  message_id?: string;
  timestamp?: string;
  raw?: Record<string, unknown>;
  attachments?: AttachmentInput[];
}

export interface NormalizedOpenClassifyInput extends OpenClassifyInput {
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
  attachments: ClassifierAttachmentInput[];
  message_hash: string;
  request_hash: string;
  external_request_id?: string;
  source?: string;
  conversation_id?: string;
  thread_id?: string;
  message_id?: string;
  timestamp?: string;
}

export interface PreflightResult {
  terminality: Terminality;
  awk: string;
}

export interface DownstreamRouteResult {
  value: DownstreamRoute;
}

export interface AdditionalHistoryNeedResult {
  value: AdditionalHistoryNeed;
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
  additional_history_need: AdditionalHistoryNeedResult;
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
