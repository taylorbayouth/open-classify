export const TERMINALITY_VALUES = [
  "terminal",
  "continue",
  "unable_to_determine",
] as const;
export type Terminality = (typeof TERMINALITY_VALUES)[number];

export const DOWNSTREAM_EXECUTION_MODE_VALUES = [
  "direct",
  "tool_assisted",
  "workflow",
  "unable_to_determine",
] as const;
export type DownstreamExecutionMode = (typeof DOWNSTREAM_EXECUTION_MODE_VALUES)[number];

export const DOWNSTREAM_MODEL_TIER_VALUES = [
  "local_fast",
  "local_strong",
  "frontier_fast",
  "frontier_strong",
  "unable_to_determine",
] as const;
export type DownstreamModelTier = (typeof DOWNSTREAM_MODEL_TIER_VALUES)[number];

export const CONTEXT_SUFFICIENCY_VALUES = [
  "self_contained",
  "adjacent_context_helpful",
  "referential",
  "incomplete_information",
  "long_context",
  "unable_to_determine",
] as const;
export type ContextSufficiency = (typeof CONTEXT_SUFFICIENCY_VALUES)[number];

export const TOOL_FAMILY_VALUES = [
  "workspace",
  "web",
  "communications",
  "documents",
  "spreadsheets",
  "project_management",
  "developer_platforms",
] as const;
export type ToolFamily = (typeof TOOL_FAMILY_VALUES)[number];

export const SECURITY_POSTURE_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
] as const;
export type SecurityPosture = (typeof SECURITY_POSTURE_VALUES)[number];

export const SECURITY_SIGNAL_VALUES = [
  "instruction_override_attempt",
  "system_prompt_probe",
  "tool_exfiltration_attempt",
  "credential_or_secret_probe",
  "credential_or_secret_handling",
  "private_data_exfiltration_risk",
  "remote_content_injection_risk",
  "encoded_or_obfuscated_content",
  "html_or_markdown_injection",
  "cross_turn_persistence_attempt",
  "destructive_action_request",
  "untrusted_code_execution",
  "bulk_sensitive_action",
  "permission_boundary_risk",
] as const;
export type SecuritySignal = (typeof SECURITY_SIGNAL_VALUES)[number];
