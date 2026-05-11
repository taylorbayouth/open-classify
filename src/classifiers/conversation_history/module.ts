// Conversation-history classifier module. Contributes two envelope slots:
//   - `relevant_conversation_history`: a slice of input.messages built from
//     `prior_messages_needed`. The classifier emits a count; the contribution
//     does the slicing here so the result never carries echoed message text.
//   - `requires_full_message_history`: pass-through boolean; the aggregator
//     ORs across contributors if multiple classifiers signal this.

import type { ClassifierModule, Contribution } from "../../manifest.js";
import { CONVERSATION_HISTORY_SYSTEM_PROMPT } from "./prompt.js";
import {
  CONVERSATION_HISTORY_FALLBACK,
  validateConversationHistory,
  type ConversationHistoryResult,
} from "./result.js";

const relevantHistoryContribution: Contribution<ConversationHistoryResult> = {
  slot: "relevant_conversation_history",
  priority: 0,
  build: (result, ctx) => {
    const count = result.prior_messages_needed;
    if (count <= 0) return undefined;
    const messages = ctx.input.messages;
    if (messages.length <= 1) return undefined;
    return messages.slice(-1 - count, -1);
  },
};

const requiresFullHistoryContribution: Contribution<ConversationHistoryResult> = {
  slot: "requires_full_message_history",
  priority: 0,
  build: (result) =>
    result.requires_full_message_history ? true : undefined,
};

export const conversationHistoryModule: ClassifierModule<
  "conversation_history",
  ConversationHistoryResult
> = {
  name: "conversation_history",
  version: "1.0.0",
  purpose:
    "Recommend how much visible conversation history the downstream assistant should include.",
  systemPrompt: CONVERSATION_HISTORY_SYSTEM_PROMPT,
  validate: validateConversationHistory,
  fallback: CONVERSATION_HISTORY_FALLBACK,
  contributions: [relevantHistoryContribution, requiresFullHistoryContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-conversation-history:v0.1.0",
    },
  },
  ui: {
    label: "Conversation history",
    renderer: "object",
  },
};
