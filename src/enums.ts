export const TERMINALITY_VALUES = [
  "terminal",
  "continue",
  "unable_to_determine",
] as const;
export type Terminality = (typeof TERMINALITY_VALUES)[number];

export const DOWNSTREAM_ROUTE_VALUES = [
  "cheap_local_answer",
  "large_local_answer",
  "frontier_model_answer",
  "tool_harness_answer",
  "workflow",
  "unable_to_determine",
] as const;
export type DownstreamRoute = (typeof DOWNSTREAM_ROUTE_VALUES)[number];

export const ADDITIONAL_HISTORY_NEED_VALUES = [
  "current_message_only",
  "summary_of_recent_conversation",
  "full_recent_conversation",
  "full_extended_conversation",
] as const;
export type AdditionalHistoryNeed = (typeof ADDITIONAL_HISTORY_NEED_VALUES)[number];

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
