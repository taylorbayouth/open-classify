// Central registry of every classifier. Adding a new classifier? You'll touch:
//   1. enums.ts        — any new categorical output values
//   2. types.ts        — the result interface, plus a key on `OpenClassifyResult`
//   3. prompts.ts      — the system prompt
//   4. ollama.ts       — a validator + a fallback shape (in pipeline.ts)
//   5. this file       — wire the prompt into CLASSIFIERS
//   6. pipeline.ts     — slot it into the route result and (if early-exit-worthy)
//                        teach the staged decision flow about it
//
// `purpose` is human-readable docs only; nothing reads it at runtime. The
// `name` field duplicates the key for ergonomic access via Object.values().

import type { ClassifierName } from "./types.js";
import {
  CONVERSATION_HISTORY_SYSTEM_PROMPT,
  MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  MODEL_SPECIALIZATION_SYSTEM_PROMPT,
  PREFLIGHT_SYSTEM_PROMPT,
  ROUTING_SYSTEM_PROMPT,
  SECURITY_SYSTEM_PROMPT,
  TOOL_FAMILY_NEED_SYSTEM_PROMPT,
} from "./prompts.js";

export interface ClassifierDefinition {
  name: ClassifierName;
  purpose: string;
  systemPrompt: string;
}

export const CLASSIFIERS = {
  preflight: {
    name: "preflight",
    purpose: "Determine whether to stop immediately or continue downstream planning.",
    systemPrompt: PREFLIGHT_SYSTEM_PROMPT,
  },
  routing: {
    name: "routing",
    purpose: "Recommend the downstream execution lane.",
    systemPrompt: ROUTING_SYSTEM_PROMPT,
  },
  conversation_history: {
    name: "conversation_history",
    purpose: "Recommend how much visible conversation history the downstream assistant should include.",
    systemPrompt: CONVERSATION_HISTORY_SYSTEM_PROMPT,
  },
  memory_retrieval_queries: {
    name: "memory_retrieval_queries",
    purpose: "Generate short saved-memory query hints for the downstream assistant.",
    systemPrompt: MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  },
  tools: {
    name: "tools",
    purpose: "Choose broad tool manifest families for downstream exposure.",
    systemPrompt: TOOL_FAMILY_NEED_SYSTEM_PROMPT,
  },
  model_specialization: {
    name: "model_specialization",
    purpose: "Choose the model or prompt specialization best suited to the message.",
    systemPrompt: MODEL_SPECIALIZATION_SYSTEM_PROMPT,
  },
  security: {
    name: "security",
    purpose: "Assess prompt injection, exfiltration, and permission boundary risk.",
    systemPrompt: SECURITY_SYSTEM_PROMPT,
  },
} as const satisfies Record<ClassifierName, ClassifierDefinition>;

export const CLASSIFIER_NAMES = Object.keys(CLASSIFIERS) as ClassifierName[];
