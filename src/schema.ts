import { z } from "zod";

export const TaskClass = z.enum([
  "chat",
  "writing",
  "code",
  "research",
  "tool_action",
  "planning",
  "unknown",
]);
export type TaskClass = z.infer<typeof TaskClass>;

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const Route = z.enum([
  "default",
  "cheap",
  "frontier",
  "web",
  "private_context",
  "confirm_side_effect",
  "reject_or_escalate",
  "fallback",
]);
export type Route = z.infer<typeof Route>;

export const ModelTier = z.enum(["local", "mini", "frontier"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const ValidationStatus = z.enum([
  "valid",
  "invalid_json",
  "schema_error",
  "repaired",
  "classifier_failed",
]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

export const ClassificationSchema = z
  .object({
    task_class: TaskClass,
    needs_fresh_info: z.boolean(),
    needs_private_context: z.boolean(),
    needs_side_effect_tool: z.boolean(),
    risk: Risk,
    confidence: z.number().min(0).max(1),
    reason: z.string().max(160),
  })
  .strict();

export type Classification = z.infer<typeof ClassificationSchema>;

export const RouteDecisionSchema = z.object({
  route: Route,
  model_tier: ModelTier,
  requires_confirmation: z.boolean(),
  requires_web: z.boolean(),
  requires_private_context: z.boolean(),
});

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const InputEnvelopeSchema = z.object({
  request_id: z.string().min(1),
  user_input: z.string().min(1),
  state_capsule: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

export const TraceSchema = z.object({
  request_id: z.string(),
  input_hash: z.string(),
  classifier_model: z.string(),
  classifier_latency_ms: z.number(),
  classifier_output: ClassificationSchema.nullable(),
  validation_status: ValidationStatus,
  route_decision: RouteDecisionSchema,
  fallback_used: z.boolean(),
  timestamp: z.string(),
});

export type Trace = z.infer<typeof TraceSchema>;
