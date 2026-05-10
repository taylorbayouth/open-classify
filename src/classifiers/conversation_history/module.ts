import type { ClassifierModule, Contribution } from "../../manifest.js";
import { CONVERSATION_HISTORY_SYSTEM_PROMPT } from "./prompt.js";
import {
  CONVERSATION_HISTORY_FALLBACK,
  validateConversationHistory,
  type ConversationHistoryResult,
} from "./result.js";

// Contributes the trimmed message tail downstream should see.
const conversationHistoryContribution: Contribution<ConversationHistoryResult> = {
  slot: "relevant_conversation_history",
  priority: 0,
  build: (result) =>
    result.relevant_conversation_history.length > 0
      ? result.relevant_conversation_history
      : undefined,
};

// Surfaces "I'm not sure I saw everything" to downstream — maps from the
// classifier's `needs_unseen_history` flag.
const requiresFullHistoryContribution: Contribution<ConversationHistoryResult> = {
  slot: "requires_full_message_history",
  priority: 0,
  build: (result) => (result.needs_unseen_history ? true : undefined),
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
  contributions: [
    conversationHistoryContribution,
    requiresFullHistoryContribution,
  ],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-conversation-history:v0.1.0",
    },
  },
  ui: {
    label: "Conversation History",
    renderer: "object",
  },
};
