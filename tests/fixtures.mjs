// Shared fixtures and helpers for the test suite.

// Sample valid outputs for each classifier module. The shape matches the
// per-module Result types in `src/classifiers/<name>/result.ts`.
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
    confidence: 0.85,
  },
  conversation_history: {
    is_standalone: true,
    refers_to_history: false,
    prior_messages_needed: 0,
    requires_full_message_history: false,
    reason: "The latest message can be handled without prior messages.",
    confidence: 0.9,
  },
  memory_retrieval_queries: {
    queries: ["user review preferences"],
    reason: "Saved user review preferences could improve the response.",
    confidence: 0.85,
  },
  tools: {
    needed: true,
    families: ["code"],
    reason: "The request requires code access.",
    confidence: 0.9,
  },
  model_specialization: {
    model_specialization: "reasoning",
    reason: "The request asks for evaluative review.",
    confidence: 0.85,
  },
  security: {
    risk_level: "normal",
    signals: [],
    reason: "No notable risk.",
    confidence: 0.95,
  },
};

// Reference test catalog. Mirrors `downstream-models.json` in spirit but is
// pared down for speed and predictability.
export const TEST_CATALOG = {
  models: [
    {
      id: "gpt-5.5",
      specializations: ["chat", "writing", "reasoning", "planning", "coding", "instruction_following"],
      execution_modes: ["direct", "tool_assisted", "workflow"],
      tiers: ["frontier_strong"],
      params_in_millions: 800000,
      context_window: 1000000,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["chat", "writing", "reasoning", "planning", "instruction_following"],
      execution_modes: ["direct", "tool_assisted", "workflow"],
      tiers: ["frontier_fast"],
      params_in_millions: 15000,
      context_window: 200000,
    },
    {
      id: "qwen2.5-coder:14b",
      specializations: ["coding"],
      execution_modes: ["direct", "tool_assisted"],
      tiers: ["local_strong"],
      params_in_millions: 14000,
      context_window: 128000,
    },
    {
      id: "gemma4:e4b-it-q4_K_M",
      specializations: ["chat", "writing", "reasoning", "planning", "instruction_following"],
      execution_modes: ["direct", "tool_assisted", "workflow"],
      tiers: ["local_fast", "local_strong"],
      params_in_millions: 4000,
      context_window: 131072,
    },
  ],
  default: "gpt-5.4-mini",
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
