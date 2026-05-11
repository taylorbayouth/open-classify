// Public barrel for the Open Classify package. Everything an external caller
// would need — input types, enums, the registry, the pipeline, the Ollama
// runner, the catalog loader, the aggregator's confidence threshold — is
// re-exported here. The build emits a single `index.js` that downstream
// consumers can import from `open-classify`.

export * from "./aggregator.js";
export * from "./catalog.js";
export * from "./classifiers.js";
export * from "./enums.js";
export * from "./input.js";
export * from "./manifest.js";
export * from "./ollama.js";
export * from "./pipeline.js";
export * from "./types.js";

// Per-classifier result types live next to each module. Re-export them so
// consumers can import them from the package root without reaching into the
// internal directory structure.
export {
  PREFLIGHT_REASON_MAX_CHARS,
  PREFLIGHT_REPLY_MAX_CHARS,
  TERMINALITY_VALUES,
  type PreflightResult,
  type Terminality,
} from "./classifiers/preflight/result.js";
export {
  ROUTING_REASON_MAX_CHARS,
  type RoutingResult,
} from "./classifiers/routing/result.js";
export {
  CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT,
  CONVERSATION_HISTORY_REASON_MAX_CHARS,
  type ConversationHistoryResult,
} from "./classifiers/conversation_history/result.js";
export {
  MEMORY_QUERY_MAX_COUNT,
  MEMORY_QUERY_MAX_WORDS,
  MEMORY_QUERY_MIN_WORDS,
  MEMORY_RETRIEVAL_QUERIES_REASON_MAX_CHARS,
  type MemoryRetrievalQueriesResult,
} from "./classifiers/memory_retrieval_queries/result.js";
export {
  TOOLS_REASON_MAX_CHARS,
  type ToolsResult,
} from "./classifiers/tools/result.js";
export {
  MODEL_SPECIALIZATION_REASON_MAX_CHARS,
  type ModelSpecializationResult,
} from "./classifiers/model_specialization/result.js";
export {
  SECURITY_REASON_MAX_CHARS,
  type SecurityResult,
} from "./classifiers/security/result.js";
