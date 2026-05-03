import { z } from "zod";

export const AwkMode = z.enum(["only", "first", "question"]);
export type AwkMode = z.infer<typeof AwkMode>;

export const ResponsePath = z.enum([
  "none",
  "small_model",
  "large_model",
  "tool_assisted",
  "workflow",
]);
export type ResponsePath = z.infer<typeof ResponsePath>;

export const ContextBudget = z.enum([
  "none",
  "current_message_only",
  "last_exchange",
  "recent_context",
  "retrieved_context_only",
  "full_conversation",
]);
export type ContextBudget = z.infer<typeof ContextBudget>;

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

export const WorkComplexity = z.enum([
  "trivial",
  "simple",
  "moderate",
  "complex",
  "multi_step",
]);
export type WorkComplexity = z.infer<typeof WorkComplexity>;

export const ValidationStatus = z.enum([
  "valid",
  "invalid_json",
  "schema_error",
  "classifier_failed",
]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

const Confidence = z.number().min(0).max(1);

export const AwkResult = z
  .object({
    text: z.string().min(1).max(280),
    mode: AwkMode,
    should_send: z.boolean(),
    confidence: Confidence,
  })
  .strict();
export type AwkResult = z.infer<typeof AwkResult>;

export const ResponsePathResult = z
  .object({ value: ResponsePath, confidence: Confidence })
  .strict();
export type ResponsePathResult = z.infer<typeof ResponsePathResult>;

export const ContextBudgetResult = z
  .object({ value: ContextBudget, confidence: Confidence })
  .strict();
export type ContextBudgetResult = z.infer<typeof ContextBudgetResult>;

export const RetrievalNeedResult = z
  .object({ value: z.array(RetrievalNeedItem).min(1), confidence: Confidence })
  .strict();
export type RetrievalNeedResult = z.infer<typeof RetrievalNeedResult>;

export const WorkComplexityResult = z
  .object({ value: WorkComplexity, confidence: Confidence })
  .strict();
export type WorkComplexityResult = z.infer<typeof WorkComplexityResult>;

export const InputEnvelopeSchema = z.object({
  request_id: z.string().min(1),
  user_input: z.string().min(1),
  state_capsule: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

export type DimensionName =
  | "awk"
  | "response_path"
  | "context_budget"
  | "retrieval_need"
  | "work_complexity";

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
export type SubResultEvent = SubResultRecord & { type: "sub_result" };

export const TraceSchema = z.object({
  request_id: z.string(),
  input_hash: z.string(),
  total_latency_ms: z.number(),
  sub_results: z.array(SubResultSchema),
  timestamp: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;
