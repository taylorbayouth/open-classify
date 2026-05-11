// Result type, validator, and fallback for the conversation_history
// classifier. The model emits `prior_messages_needed`; the runner uses it
// (via this module's `relevant_conversation_history` contribution) to slice
// the right suffix of the input messages. The classifier itself never
// echoes message text — that would waste tokens and risk drift.

import {
  ensureExactKeys,
  isRecord,
  requireBoolean,
  requireConfidence,
  requireNonNegativeSafeInteger,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT = 19;
export const CONVERSATION_HISTORY_REASON_MAX_CHARS = 200;

export interface ConversationHistoryResult extends ClassifierResultBase {
  is_standalone: boolean;
  refers_to_history: boolean;
  prior_messages_needed: number;
  requires_full_message_history: boolean;
}

export function validateConversationHistory(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): ConversationHistoryResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    [
      "is_standalone",
      "refers_to_history",
      "prior_messages_needed",
      "requires_full_message_history",
      "reason",
      "confidence",
    ],
    ctx.name,
    ctx.model,
  );

  const priorMessagesNeeded = requireNonNegativeSafeInteger(
    value.prior_messages_needed,
    ctx.name,
    ctx.model,
    "prior_messages_needed",
  );
  if (priorMessagesNeeded > CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT) {
    throwInvalid(
      ctx.name,
      ctx.model,
      `prior_messages_needed must be ${CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT} or fewer`,
    );
  }

  const isStandalone = requireBoolean(value.is_standalone, ctx.name, ctx.model, "is_standalone");
  const refersToHistory = requireBoolean(
    value.refers_to_history,
    ctx.name,
    ctx.model,
    "refers_to_history",
  );
  const requiresFullMessageHistory = requireBoolean(
    value.requires_full_message_history,
    ctx.name,
    ctx.model,
    "requires_full_message_history",
  );

  if (
    isStandalone &&
    (refersToHistory || priorMessagesNeeded !== 0 || requiresFullMessageHistory)
  ) {
    throwInvalid(
      ctx.name,
      ctx.model,
      "standalone conversation_history must not require history",
    );
  }

  return {
    is_standalone: isStandalone,
    refers_to_history: refersToHistory,
    prior_messages_needed: priorMessagesNeeded,
    requires_full_message_history: requiresFullMessageHistory,
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      CONVERSATION_HISTORY_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

// Conservative fallback: assume context is needed but we couldn't determine
// what. Confidence 0 makes the aggregator ignore threshold-gated signals.
export const CONVERSATION_HISTORY_FALLBACK: ConversationHistoryResult = {
  is_standalone: false,
  refers_to_history: false,
  prior_messages_needed: 0,
  requires_full_message_history: true,
  reason: "",
  confidence: 0,
};
