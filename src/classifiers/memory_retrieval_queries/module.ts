// Memory retrieval queries classifier module. Contributes a single envelope
// slot: `memory_queries` (concat + dedupe across all contributors).

import type { ClassifierModule, Contribution } from "../../manifest.js";
import { MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT } from "./prompt.js";
import {
  MEMORY_RETRIEVAL_QUERIES_FALLBACK,
  validateMemoryRetrievalQueries,
  type MemoryRetrievalQueriesResult,
} from "./result.js";

const memoryQueriesContribution: Contribution<MemoryRetrievalQueriesResult> = {
  slot: "memory_queries",
  priority: 0,
  build: (result) => (result.queries.length === 0 ? undefined : result.queries),
};

export const memoryRetrievalQueriesModule: ClassifierModule<
  "memory_retrieval_queries",
  MemoryRetrievalQueriesResult
> = {
  name: "memory_retrieval_queries",
  version: "1.0.0",
  purpose:
    "Generate short saved-memory query hints for the downstream assistant.",
  systemPrompt: MEMORY_RETRIEVAL_QUERIES_SYSTEM_PROMPT,
  validate: validateMemoryRetrievalQueries,
  fallback: MEMORY_RETRIEVAL_QUERIES_FALLBACK,
  contributions: [memoryQueriesContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-memory-retrieval-queries:v0.1.0",
    },
  },
  ui: {
    label: "Memory queries",
    renderer: "list",
  },
};
