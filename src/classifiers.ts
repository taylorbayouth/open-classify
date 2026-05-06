import type { ClassifierName } from "./types.js";
import {
  CONVERSATION_HISTORY_SYSTEM_PROMPT,
  MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  MESSAGE_AND_ATTACHMENT_DIGEST_SYSTEM_PROMPT,
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
  message_and_attachment_digest: {
    name: "message_and_attachment_digest",
    purpose: "Create a compact digest of the message and attachments.",
    systemPrompt: MESSAGE_AND_ATTACHMENT_DIGEST_SYSTEM_PROMPT,
  },
  security: {
    name: "security",
    purpose: "Assess prompt injection, exfiltration, and permission boundary risk.",
    systemPrompt: SECURITY_SYSTEM_PROMPT,
  },
} as const satisfies Record<ClassifierName, ClassifierDefinition>;

export const CLASSIFIER_NAMES = Object.keys(CLASSIFIERS) as ClassifierName[];
