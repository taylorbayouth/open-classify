import type {
  AdditionalHistoryNeed,
  DownstreamRoute,
  SecurityPosture,
  SecuritySignal,
  Terminality,
  ToolFamily,
} from "./enums.js";

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
