/**
 * Zod schemas and inferred types for every value the harness produces.
 *
 * The 5 sub-classifier result schemas (`AwkResult`, `ResponsePathResult`,
 * `ContextBudgetResult`, `RetrievalNeedResult`, `WorkComplexityResult`) are the
 * contract each sub-classifier model must return. `SubResultSchema` is the
 * single source of truth for the per-dimension record that flows through the
 * stream, the trace, and the UI — see {@link SubResultRecord} and
 * {@link SubResultEvent}. `TraceSchema` describes the persisted trace.
 */
import { z } from "zod";

/** `awk.mode` — how the immediate acknowledgement should be interpreted. */
export const AwkMode = z.enum(["only", "first", "question"]);
export type AwkMode = z.infer<typeof AwkMode>;

/** `response_path.value` — what (if anything) happens after the awk is sent. */
export const ResponsePath = z.enum([
  "none",
  "small_model",
  "large_model",
  "tool_assisted",
  "workflow",
]);
export type ResponsePath = z.infer<typeof ResponsePath>;

/** `context_budget.value` — how much conversation context downstream should receive. */
export const ContextBudget = z.enum([
  "none",
  "current_message_only",
  "last_exchange",
  "recent_context",
  "retrieved_context_only",
  "full_conversation",
]);
export type ContextBudget = z.infer<typeof ContextBudget>;

/** One element of `retrieval_need.value` — `retrieval_need` always returns an array. */
export const RetrievalNeedItem = z.enum([
  "none",
  "memory",
  "files",
  "web",
  "browser",
  "email_calendar",
  "system_local_state",
  "other",
]);
export type RetrievalNeedItem = z.infer<typeof RetrievalNeedItem>;

/** `work_complexity.value` — coarse effort estimate for whatever happens after classification. */
export const WorkComplexity = z.enum([
  "trivial",
  "simple",
  "moderate",
  "complex",
  "multi_step",
]);
export type WorkComplexity = z.infer<typeof WorkComplexity>;

/**
 * Outcome of a single sub-classifier call.
 *
 * - `valid` — the model returned JSON that parsed against the dimension's schema.
 * - `invalid_json` — the response was not parseable JSON (or no `{...}` block could be extracted).
 * - `schema_error` — the JSON parsed but did not match the dimension schema.
 * - `classifier_failed` — the call threw, timed out, or was aborted.
 */
export const ValidationStatus = z.enum([
  "valid",
  "invalid_json",
  "schema_error",
  "classifier_failed",
]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/** Self-reported confidence from a sub-classifier, 0–1 inclusive. */
const Confidence = z.number().min(0).max(1);

/** Result schema for the `awk` sub-classifier — the immediate user-facing acknowledgement. */
export const AwkResult = z
  .object({
    text: z.string().min(1).max(280),
    mode: AwkMode,
    should_send: z.boolean(),
    confidence: Confidence,
  })
  .strict();
export type AwkResult = z.infer<typeof AwkResult>;

/** Result schema for the `response_path` sub-classifier. */
export const ResponsePathResult = z
  .object({ value: ResponsePath, confidence: Confidence })
  .strict();
export type ResponsePathResult = z.infer<typeof ResponsePathResult>;

/** Result schema for the `context_budget` sub-classifier. */
export const ContextBudgetResult = z
  .object({ value: ContextBudget, confidence: Confidence })
  .strict();
export type ContextBudgetResult = z.infer<typeof ContextBudgetResult>;

/** Result schema for the `retrieval_need` sub-classifier. `value` is always a non-empty array. */
export const RetrievalNeedResult = z
  .object({ value: z.array(RetrievalNeedItem).min(1), confidence: Confidence })
  .strict();
export type RetrievalNeedResult = z.infer<typeof RetrievalNeedResult>;

/** Result schema for the `work_complexity` sub-classifier. */
export const WorkComplexityResult = z
  .object({ value: WorkComplexity, confidence: Confidence })
  .strict();
export type WorkComplexityResult = z.infer<typeof WorkComplexityResult>;

/**
 * What gets handed to {@link classify}: the user's message plus a
 * caller-provided `request_id` for trace correlation. Optional state and
 * metadata are accepted but currently unused — they exist as forward-compatible
 * hooks for future routing logic.
 */
export const InputEnvelopeSchema = z.object({
  request_id: z.string().min(1),
  user_input: z.string().min(1),
  state_capsule: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

/** Identifier for one of the 5 sub-classifiers. */
export type DimensionName =
  | "awk"
  | "response_path"
  | "context_budget"
  | "retrieval_need"
  | "work_complexity";

/**
 * One sub-classifier's full record — the canonical shape that flows through
 * the streaming endpoint, the trace, and the UI. `data` is the parsed model
 * output (one of the `*Result` shapes) when `validation_status === "valid"`,
 * and `null` otherwise. `raw_output` is always preserved (including model
 * `<think>` blocks) so failures stay debuggable.
 */
export const SubResultSchema = z.object({
  dimension: z.enum(["awk", "response_path", "context_budget", "retrieval_need", "work_complexity"]),
  data: z.unknown().nullable(),
  latency_ms: z.number(),
  raw_output: z.string(),
  prompt: z.string(),
  model: z.string(),
  validation_status: ValidationStatus,
});
export type SubResultRecord = z.infer<typeof SubResultSchema>;

/**
 * A {@link SubResultRecord} tagged for transport over the streaming endpoint.
 * The `type` discriminator lets clients distinguish sub-results from `started`
 * / `complete` envelope frames in the NDJSON stream.
 */
export type SubResultEvent = SubResultRecord & { type: "sub_result" };

/**
 * Persisted classification trace. Note that `input_hash` (SHA-256 of the user
 * input) is stored deliberately in place of the raw input — `GET /traces`
 * exposes traces broadly, and we don't want to leak user content.
 */
export const TraceSchema = z.object({
  request_id: z.string(),
  input_hash: z.string(),
  total_latency_ms: z.number(),
  sub_results: z.array(SubResultSchema),
  timestamp: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;
