import { z } from "zod";

export const TaskClass = z.enum(["chat", "draft", "code", "research"]);
export type TaskClass = z.infer<typeof TaskClass>;

export const NeedsMemory = z.enum(["none", "recent", "session", "long_term"]);
export type NeedsMemory = z.infer<typeof NeedsMemory>;

export const SuggestedModel = z.enum([
  "local_fast",
  "local_slow",
  "billed_mini",
  "billed_frontier",
]);
export type SuggestedModel = z.infer<typeof SuggestedModel>;

export const Security = z.enum(["clean", "suspicious", "prompt_injection"]);
export type Security = z.infer<typeof Security>;

export const Route = z.enum([
  "local_fast",
  "local_slow",
  "billed_mini",
  "billed_frontier",
  "reject",
  "fallback",
]);
export type Route = z.infer<typeof Route>;

export const ValidationStatus = z.enum([
  "valid",
  "invalid_json",
  "schema_error",
  "classifier_failed",
]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

export const EscalationReason = z.enum([
  "low_confidence",
  "suspicious",
  "prompt_injection",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

const ConfidenceField = z.number().min(0).max(1);

// Per-classifier output schemas (what each parallel call returns)
export const TaskClassResult = z
  .object({ task_class: TaskClass, confidence: ConfidenceField })
  .strict();
export const MemoryResult = z
  .object({ needs_memory: NeedsMemory, confidence: ConfidenceField })
  .strict();
export const ToolsResult = z
  .object({ tools_required: z.boolean(), confidence: ConfidenceField })
  .strict();
export const ModelResult = z
  .object({ suggested_model: SuggestedModel, confidence: ConfidenceField })
  .strict();
export const SecurityResult = z
  .object({ security: Security, confidence: ConfidenceField })
  .strict();

// Aggregated classification (what all 5 results combine into)
export const ClassificationSchema = z.object({
  task_class: TaskClass,
  needs_memory: NeedsMemory,
  tools_required: z.boolean(),
  suggested_model: SuggestedModel,
  security: Security,
  confidences: z.object({
    task_class: ConfidenceField,
    needs_memory: ConfidenceField,
    tools_required: ConfidenceField,
    suggested_model: ConfidenceField,
    security: ConfidenceField,
  }),
  average_confidence: ConfidenceField,
  min_confidence: ConfidenceField,
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const RouteDecisionSchema = z.object({
  route: Route,
  requires_confirmation: z.boolean(),
  tools_required: z.boolean(),
  memory_scope: NeedsMemory,
  escalated: z.boolean(),
  escalation_reason: EscalationReason.nullable(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const InputEnvelopeSchema = z.object({
  request_id: z.string().min(1),
  user_input: z.string().min(1),
  state_capsule: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

export const SubLatenciesSchema = z.object({
  task_class: z.number(),
  needs_memory: z.number(),
  tools_required: z.number(),
  suggested_model: z.number(),
  security: z.number(),
});
export type SubLatencies = z.infer<typeof SubLatenciesSchema>;

export const TraceSchema = z.object({
  request_id: z.string(),
  input_hash: z.string(),
  classifier_model: z.string(),
  classifier_latency_ms: z.number(),
  sub_latencies: SubLatenciesSchema.nullable(),
  classifier_output: ClassificationSchema.nullable(),
  validation_status: ValidationStatus,
  route_decision: RouteDecisionSchema,
  fallback_used: z.boolean(),
  timestamp: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;
