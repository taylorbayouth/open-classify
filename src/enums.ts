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

export const SECURITY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unable_to_determine",
] as const;
export type SecurityRiskLevel = (typeof SECURITY_RISK_LEVEL_VALUES)[number];

export const SECURITY_SIGNAL_VALUES = [
  "instruction_attack",
  "secret_or_private_data_risk",
  "unsafe_tool_or_action",
  "untrusted_content_or_code",
  "injection_or_obfuscation",
] as const;
export type SecuritySignal = (typeof SECURITY_SIGNAL_VALUES)[number];
