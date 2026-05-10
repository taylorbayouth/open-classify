// Shared fixtures and helpers for the test suite.

export const validClassifierOutputs = {
  preflight: {
    terminality: "continue",
    reply: "Let me check.",
    reason: "The latest message requires downstream work.",
    confidence: 0.85,
  },
  routing: {
    execution_mode: "tool_assisted",
    model_tier: "local_strong",
    reason: "The request needs tools and moderate reasoning.",
  },
  conversation_history: {
    is_standalone: true,
    refers_to_history: false,
    relevant_conversation_history: [],
    needs_unseen_history: false,
    reason: "The latest message can be handled without prior messages.",
  },
  memory_retrieval_queries: {
    queries: ["user review preferences"],
    reason: "Saved user review preferences could improve the response.",
  },
  tools: {
    needed: true,
    families: ["code"],
    reason: "The request requires code access.",
  },
  model_specialization: {
    model_specialization: "reasoning",
    reason: "The request asks for evaluative review.",
  },
  security: {
    risk_level: "normal",
    signals: [],
    reason: "No notable risk.",
  },
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
