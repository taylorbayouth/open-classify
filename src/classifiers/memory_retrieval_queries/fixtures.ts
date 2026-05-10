import type { MemoryRetrievalQueriesResult } from "./result.js";

export const VALID_MEMORY_RETRIEVAL_QUERIES_OUTPUT: MemoryRetrievalQueriesResult = {
  queries: ["user review preferences"],
  reason: "Saved user review preferences could improve the response.",
  confidence: 0.78,
};
