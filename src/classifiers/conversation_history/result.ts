import type {
  ClassifierResultBase,
  ClassifierValidationContext,
} from "../../manifest.js";
import type { ConversationMessageInput } from "../../types.js";
import {
  ensureExactKeys,
  isRecord,
  requireBoolean,
  requireConfidence,
  requireNonNegativeSafeInteger,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";

export const CONVERSATION_HISTORY_REASON_MAX_CHARS = 200;
export const CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT = 19;

export interface ConversationHistoryResult extends ClassifierResultBase {
  is_standalone: boolean;
  refers_to_history: boolean;
  // Sliced from the input messages by the validator using the model's
  // `prior_messages_needed` count. The classifier never echoes message
  // text back — that would leak and waste tokens.
  relevant_conversation_history: ConversationMessageInput[];
  needs_unseen_history: boolean;
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
      "needs_unseen_history",
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

  const isStandalone = requireBoolean(
    value.is_standalone,
    ctx.name,
    ctx.model,
    "is_standalone",
  );
  const refersToHistory = requireBoolean(
    value.refers_to_history,
    ctx.name,
    ctx.model,
    "refers_to_history",
  );
  const needsUnseenHistory = requireBoolean(
    value.needs_unseen_history,
    ctx.name,
    ctx.model,
    "needs_unseen_history",
  );

  if (
    isStandalone &&
    (refersToHistory || priorMessagesNeeded !== 0 || needsUnseenHistory)
  ) {
    throwInvalid(
      ctx.name,
      ctx.model,
      "standalone conversation_history must not require history",
    );
  }

  const inputMessages = ctx.input.messages;
  const relevantConversationHistory =
    priorMessagesNeeded > 0 && inputMessages.length > 1
      ? inputMessages.slice(-1 - priorMessagesNeeded, -1)
      : [];

  return {
    is_standalone: isStandalone,
    refers_to_history: refersToHistory,
    relevant_conversation_history: relevantConversationHistory,
    needs_unseen_history: needsUnseenHistory,
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

export const CONVERSATION_HISTORY_FALLBACK: ConversationHistoryResult = {
  is_standalone: false,
  refers_to_history: false,
  relevant_conversation_history: [],
  needs_unseen_history: true,
  reason: "",
  confidence: 0,
};
