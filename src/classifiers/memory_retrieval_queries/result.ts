// Result type, validator, and fallback for the memory retrieval queries
// classifier. The model emits up to 3 short query strings; the aggregator
// dedupes across contributors and surfaces them to downstream RAG/memory
// search layers via the `memory_queries` envelope slot.

import {
  ensureExactKeys,
  ensureNoDuplicates,
  isRecord,
  requireConfidence,
  requireStringArray,
  requireStringMaxLength,
  throwInvalid,
} from "../../validation.js";
import type { ClassifierResultBase, ClassifierValidationContext } from "../../manifest.js";

export const MEMORY_QUERY_MAX_COUNT = 3;
export const MEMORY_QUERY_MIN_WORDS = 3;
export const MEMORY_QUERY_MAX_WORDS = 10;
export const MEMORY_RETRIEVAL_QUERIES_REASON_MAX_CHARS = 200;

export interface MemoryRetrievalQueriesResult extends ClassifierResultBase {
  queries: string[];
}

export function validateMemoryRetrievalQueries(
  value: Record<string, unknown>,
  ctx: ClassifierValidationContext,
): MemoryRetrievalQueriesResult {
  if (!isRecord(value)) {
    throwInvalid(ctx.name, ctx.model, "value must be a JSON object");
  }
  ensureExactKeys(
    value,
    ["queries", "reason", "confidence"],
    ctx.name,
    ctx.model,
  );
  const queries = requireStringArray(value.queries, ctx.name, ctx.model, "queries").map(
    (query, index) => {
      const trimmed = query.trim();
      const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
      if (wordCount < MEMORY_QUERY_MIN_WORDS || wordCount > MEMORY_QUERY_MAX_WORDS) {
        throwInvalid(
          ctx.name,
          ctx.model,
          `queries[${index}] must be ${MEMORY_QUERY_MIN_WORDS} to ${MEMORY_QUERY_MAX_WORDS} words`,
        );
      }
      return trimmed;
    },
  );

  if (queries.length > MEMORY_QUERY_MAX_COUNT) {
    throwInvalid(
      ctx.name,
      ctx.model,
      `queries must contain ${MEMORY_QUERY_MAX_COUNT} items or fewer`,
    );
  }
  ensureNoDuplicates(queries, ctx.name, ctx.model, "queries");

  return {
    queries,
    reason: requireStringMaxLength(
      value.reason,
      ctx.name,
      ctx.model,
      "reason",
      MEMORY_RETRIEVAL_QUERIES_REASON_MAX_CHARS,
    ),
    confidence: requireConfidence(value.confidence, ctx.name, ctx.model),
  };
}

export const MEMORY_RETRIEVAL_QUERIES_FALLBACK: MemoryRetrievalQueriesResult = {
  queries: [],
  reason: "",
  confidence: 0,
};
