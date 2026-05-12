// Shared fixtures and helpers for the test suite.

// Sample valid outputs for each built-in classifier manifest, in the new
// flat-per-signal shape: each classifier's output IS its signal, with optional
// reason/confidence metadata attached.
export const validClassifierOutputs = {
  preflight: {
    reason: "The latest message requires downstream work.",
    confidence: 0.85,
    ack_reply: { reply: "Let me check." },
  },
  routing: {
    reason: "The request needs moderate reasoning.",
    confidence: 0.85,
    model_tier: "local_strong",
  },
  memory_retrieval_queries: {
    reason: "Saved user review preferences could improve the response.",
    confidence: 0.85,
    output: { queries: ["user review preferences"] },
  },
  conversation_diegest: {
    reason: "Conversation compression is useful downstream context.",
    confidence: 0.9,
    output: {
      history_summary: "",
      latest_user_message_summary: "User asks for code review.",
    },
  },
  tools: {
    reason: "The request requires code access.",
    confidence: 0.9,
    tools: ["workspace"],
  },
  model_specialization: {
    reason: "The request asks for evaluative review.",
    confidence: 0.85,
    specialization: "reasoning",
  },
  security: {
    reason: "No notable risk.",
    confidence: 0.95,
    decision: "allow",
    risk_level: "normal",
    signals: [],
  },
};

// Reference test catalog. Mirrors `downstream-models.json` in spirit but is
// pared down for speed and predictability.
export const TEST_CATALOG = {
  models: [
    {
      id: "gpt-5.5",
      specializations: ["chat", "writing", "reasoning", "planning", "coding", "instruction_following"],
      tier: "frontier_strong",
      params_in_billions: 800,
      context_window: 1000000,
      input_tokens_cpm: 5,
      cached_tokens_cpm: 0.5,
      output_tokens_cpm: 25,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["chat", "writing", "reasoning", "planning", "instruction_following"],
      tier: "frontier_fast",
      params_in_billions: 15,
      context_window: 200000,
      input_tokens_cpm: 0.25,
      cached_tokens_cpm: 0.03,
      output_tokens_cpm: 1.25,
    },
    {
      id: "qwen2.5-coder:14b",
      specializations: ["coding"],
      tier: "local_strong",
      params_in_billions: 14,
      context_window: 128000,
    },
    {
      id: "gemma4:e4b-it-q4_K_M",
      specializations: ["chat", "writing", "reasoning", "planning", "instruction_following"],
      tier: "local_strong",
      params_in_billions: 4,
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
    target_message_hash: "message",
    ...overrides,
  };
}

export function userMessage(text, extra = {}) {
  return { role: "user", text, ...extra };
}
