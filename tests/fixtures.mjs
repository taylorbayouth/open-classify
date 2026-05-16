// Shared fixtures and helpers for the test suite.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

// Sample valid outputs for each built-in classifier manifest. Reserved fields
// and custom payload fields sit at the top level alongside `reason` and
// `certainty` — there is no `output` wrapper.
export const validClassifierOutputs = {
  preflight: {
    reason: "The latest message requires downstream work.",
    certainty: "strong",
    ack_reply: { text: "Let me check." },
  },
  model_tier: {
    reason: "The request needs moderate reasoning.",
    certainty: "strong",
    model_tier: "local_strong",
  },
  memory_retrieval_queries: {
    reason: "Saved user review preferences could improve the response.",
    certainty: "strong",
    queries: ["user review preferences"],
  },
  conversation_digest: {
    reason: "Conversation compression is useful downstream context.",
    certainty: "very_strong",
    history_summary: "",
    latest_user_message_summary: "User asks for code review.",
  },
  context_shift: {
    reason: "The request directly continues the active code review thread.",
    certainty: "strong",
    decision: "same_active_thread",
  },
  tools: {
    reason: "The request requires code access.",
    certainty: "very_strong",
    tools: ["workspace"],
  },
  model_specialization: {
    reason: "The request asks for evaluative review.",
    certainty: "strong",
    model_specialization: "reasoning",
  },
  prompt_injection: {
    reason: "No notable risk.",
    certainty: "near_certain",
    risk_level: "normal",
  },
};

// Reference test catalog. Mirrors `downstream-models.json` in spirit but is
// pared down for speed and predictability.
export const TEST_CATALOG = {
  models: [
    {
      id: "gpt-5.5",
      specializations: ["chat", "writing", "reasoning", "planning", "coding", "tool_use"],
      tier: "frontier_strong",
      params_in_billions: null,
      context_window: 1050000,
      input_tokens_cpm: 5,
      cached_tokens_cpm: 0.5,
      output_tokens_cpm: 30,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["chat", "writing", "reasoning", "planning"],
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
      specializations: ["chat", "writing", "reasoning", "planning"],
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

// Copy one of the package's templates (the four non-mandatory classifiers
// that ship in `templates/`) into a temp directory so a test can pass it
// via `extraClassifierDirs`. Mirrors what `npx open-classify init` does
// for consumers, minus the underscore prefix.
export function templateAsExtra(name) {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-template-extra-"));
  cpSync(join(TEMPLATES_DIR, name), join(dir, name), { recursive: true });
  return dir;
}
