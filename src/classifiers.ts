import type { ClassifierName } from "./types.js";
import {
  CONTEXT_SUFFICIENCY_SYSTEM_PROMPT,
  DOWNSTREAM_ROUTE_SYSTEM_PROMPT,
  MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  MESSAGE_AND_ATTACHMENT_DIGEST_SYSTEM_PROMPT,
  PREFLIGHT_SYSTEM_PROMPT,
  SECURITY_POSTURE_SYSTEM_PROMPT,
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
  downstream_route: {
    name: "downstream_route",
    purpose: "Choose the downstream execution lane.",
    systemPrompt: DOWNSTREAM_ROUTE_SYSTEM_PROMPT,
  },
  context_sufficiency: {
    name: "context_sufficiency",
    purpose: "Assess whether the final message is understandable with the supplied conversation window.",
    systemPrompt: CONTEXT_SUFFICIENCY_SYSTEM_PROMPT,
  },
  memory_retrieval_queries: {
    name: "memory_retrieval_queries",
    purpose: "Generate short saved-memory query hints for the downstream assistant.",
    systemPrompt: MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  },
  tool_family_need: {
    name: "tool_family_need",
    purpose: "Choose broad tool manifest families for downstream exposure.",
    systemPrompt: TOOL_FAMILY_NEED_SYSTEM_PROMPT,
  },
  message_and_attachment_digest: {
    name: "message_and_attachment_digest",
    purpose: "Create a compact digest of the message and attachments.",
    systemPrompt: MESSAGE_AND_ATTACHMENT_DIGEST_SYSTEM_PROMPT,
  },
  security_posture: {
    name: "security_posture",
    purpose: "Assess prompt injection, exfiltration, and permission boundary risk.",
    systemPrompt: SECURITY_POSTURE_SYSTEM_PROMPT,
  },
} as const satisfies Record<ClassifierName, ClassifierDefinition>;

export const CLASSIFIER_NAMES = Object.keys(CLASSIFIERS) as ClassifierName[];
