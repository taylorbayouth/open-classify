// Shared input + run-status types. Classifier result types now live next to
// their modules in `src/classifiers/<name>/result.ts`; pipeline result types
// live in `src/manifest.ts` (generic) and are bound to the concrete registry
// from `src/classifiers.ts`. This file is intentionally small: it should only
// hold the contract for what callers send in and the operational metadata
// every classifier carries alongside its verdict.

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

// Result of running the input through `normalizeOpenClassifyInput`. `text` is
// the final message's sanitized text (the thing actually being classified);
// `target_message_hash` is a stable 8-hex-char fingerprint of the target
// message, useful for deduping or correlating results.
export interface NormalizedOpenClassifyInput {
  messages: ConversationMessageInput[];
  text: string;
  attachments: AttachmentInput[];
  target_message_hash: string;
}

// What every classifier sees. Structurally identical to the normalized input —
// kept as its own type so future divergence (e.g. classifier-specific
// projections) doesn't break the public contract.
export interface ClassifierInput {
  text: string;
  messages: ConversationMessageInput[];
  attachments: AttachmentInput[];
  target_message_hash: string;
}

// Why a classifier fell back to its default output instead of a model answer.
export type ClassifierFallbackReason = "error" | "timeout";

// Per-classifier execution metadata. Lives inside the merged classifier entry
// (`meta.classifiers[name]`) so callers see the verdict and the operational
// state in one place.
export interface ClassifierRunStatus {
  ok: boolean;
  source: "model" | "fallback";
  reason?: ClassifierFallbackReason;
  error?: string;
}
