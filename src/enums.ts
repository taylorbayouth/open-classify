// Shared categorical enums used by more than one classifier or by the
// catalog. Each enum is exported twice: once as a `*_VALUES` array (used by
// validators and tests) and once as a string-literal union type derived from
// the array via `(typeof X)[number]`. Keep the array and the type in sync.
//
// Classifier outputs omit uncertain optional fields rather than emitting an
// escape-hatch value, so these enums list only concrete choices.

// Coarse capability+latency tier for the downstream model. Callers map these
// onto concrete model names via the catalog.
export const DOWNSTREAM_MODEL_TIER_VALUES = [
  "local_fast",
  "local_small",
  "local_strong",
  "local_coding",
  "frontier_fast",
  "frontier_strong",
  "frontier_coding",
] as const;
export type DownstreamModelTier = (typeof DOWNSTREAM_MODEL_TIER_VALUES)[number];

// Which kind of model/prompt specialization fits the request best. Combined
// with the tier to look up a concrete model in the catalog.
export const MODEL_SPECIALIZATION_VALUES = [
  "chat",
  "reasoning",
  "planning",
  "writing",
  "summarization",
  "coding",
  "tool_use",
  "computer_use",
  "vision",
] as const;
export type ModelSpecialization = (typeof MODEL_SPECIALIZATION_VALUES)[number];

// Overall safety posture on the latest user message. The pipeline blocks
// confident high_risk and unknown security outputs.
export const SECURITY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unknown",
] as const;
export type SecurityRiskLevel = (typeof SECURITY_RISK_LEVEL_VALUES)[number];

// Specific safety concerns the security classifier can flag. These are evidence
// labels, not actions; risk_level controls whether the pipeline blocks.
export const SECURITY_SIGNAL_VALUES = [
  "instruction_attack",
  "secret_or_private_data_risk",
  "unsafe_tool_or_action",
  "untrusted_content_or_code",
  "injection_or_obfuscation",
] as const;
export type SecuritySignal = (typeof SECURITY_SIGNAL_VALUES)[number];
