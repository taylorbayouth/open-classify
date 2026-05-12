// Shared categorical enums used by more than one classifier or by the
// catalog. Classifier manifests declare which stock fields they emit.
// Each enum is exported twice:
// once as a `*_VALUES` array (used by validators and tests) and once as a
// string-literal union type. Keep the array and the type in sync — the type
// is derived from the array via `(typeof X)[number]`.
//
// Some catalog-facing enums still include an `unable_to_determine` escape
// hatch for older config validation; stock classifier outputs omit uncertain
// optional fields instead of emitting escape-hatch values.

// How the downstream model should be invoked. `direct` is a plain chat call;
// `tool_assisted` expects tool/function calling; `workflow` implies a multi-
// step plan.
export const DOWNSTREAM_EXECUTION_MODE_VALUES = [
  "direct",
  "tool_assisted",
  "workflow",
  "unable_to_determine",
] as const;
export type DownstreamExecutionMode = (typeof DOWNSTREAM_EXECUTION_MODE_VALUES)[number];

// Coarse capability+latency tier for the downstream model. Callers map these
// onto concrete model names via `DownstreamModelConfig` (see types.ts).
export const DOWNSTREAM_MODEL_TIER_VALUES = [
  "local_fast",
  "local_small",
  "local_strong",
  "local_coding",
  "frontier_fast",
  "frontier_strong",
  "frontier_coding",
  "unable_to_determine",
] as const;
export type DownstreamModelTier = (typeof DOWNSTREAM_MODEL_TIER_VALUES)[number];

// Broad tool families the downstream assistant might need exposed. Intentionally
// coarse — tool-level decisions happen downstream once the manifest is loaded.
export const TOOL_FAMILY_VALUES = [
  "web",                // search, fetch, browse
  "email_and_chat",     // Gmail, Slack, Teams, Discord, iMessage
  "calendar",           // Google Calendar, Outlook, scheduling
  "files",              // Drive, Dropbox, Box, local file ops
  "docs_and_sheets",    // Google Docs, Notion, Word, Sheets, Excel, Airtable
  "tasks_and_projects", // Jira, Linear, Asana, Todoist, Trello, GitHub Issues
  "code",               // GitHub, GitLab, Vercel, AWS, CI/CD, deploy
  "business_apps",      // CRM (Salesforce, HubSpot), finance (Stripe), design (Figma), everything else
] as const;
export type ToolFamily = (typeof TOOL_FAMILY_VALUES)[number];

// Which kind of model/prompt specialization fits the request best. Combined
// with the tier to look up a concrete model in `DownstreamModelConfig`.
export const MODEL_SPECIALIZATION_VALUES = [
  "agentic_coding",
  "agentic_workflows",
  "chat",
  "code_fixing",
  "code_reasoning",
  "code_review",
  "writing",
  "reasoning",
  "planning",
  "coding",
  "computer_use",
  "debugging",
  "instruction_following",
  "question_answering",
  "subagents",
  "summarization",
  "tool_assisted_coding",
  "vision_input",
  "unclear",
] as const;
export type ModelSpecialization = (typeof MODEL_SPECIALIZATION_VALUES)[number];

export const SECURITY_DECISION_VALUES = [
  "allow",
  "block",
  "needs_review",
] as const;
export type SecurityDecision = (typeof SECURITY_DECISION_VALUES)[number];

// Overall safety posture on the latest user message. Security short-circuiting
// is driven by safety.decision, not risk level alone.
export const SECURITY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unable_to_determine",
] as const;
export type SecurityRiskLevel = (typeof SECURITY_RISK_LEVEL_VALUES)[number];

// Specific safety concerns the security classifier can flag. These are
// advisory; safety.decision controls whether the pipeline blocks or needs review.
export const SECURITY_SIGNAL_VALUES = [
  "instruction_attack",
  "secret_or_private_data_risk",
  "unsafe_tool_or_action",
  "untrusted_content_or_code",
  "injection_or_obfuscation",
] as const;
export type SecuritySignal = (typeof SECURITY_SIGNAL_VALUES)[number];
