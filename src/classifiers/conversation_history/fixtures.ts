import type { ConversationHistoryResult } from "./result.js";

export const VALID_CONVERSATION_HISTORY_OUTPUT: ConversationHistoryResult = {
  is_standalone: true,
  refers_to_history: false,
  relevant_conversation_history: [],
  needs_unseen_history: false,
  reason: "The latest message can be handled without prior messages.",
  confidence: 0.88,
};
