// Shared fixtures and helpers for the test suite.

export const validClassifierOutputs = {
  preflight: { terminality: "continue", reply: "Let me check." },
  routing: { execution_mode: "tool_assisted", model_tier: "local_strong" },
  conversation_history: {
    is_standalone: true,
    refers_to_history: false,
    relevant_conversation_history: [],
    needs_unseen_history: false,
    reason: "The latest message can be handled without prior messages.",
  },
  memory_retrieval_queries: { queries: ["user review preferences"] },
  tools: { needed: true, families: ["workspace"] },
  message_and_attachment_digest: {
    slug: "review_request",
    summary: "The user wants a review.",
    attachments: [],
  },
  security: { risk_level: "normal", signals: [], notes: "No notable risk." },
};

export function jsonResponse(payload, overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    statusText: overrides.statusText ?? "OK",
    async json() {
      return payload;
    },
  };
}

export function classifierInput(overrides = {}) {
  return {
    text: "hello",
    messages: [{ role: "user", text: "hello" }],
    attachments: [],
    target_message_hash: "message",
    ...overrides,
  };
}

export function userMessage(text, extra = {}) {
  return { role: "user", text, ...extra };
}
