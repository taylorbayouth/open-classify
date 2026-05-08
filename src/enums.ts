// All classifier outputs that are categorical live here. Each enum is exported
// twice: once as a `*_VALUES` array (used by validators and tests) and once as
// a string-literal union type (used everywhere else). Keep the array and the
// type in sync — the type is derived from the array via `(typeof X)[number]`.
//
// Most enums include an `unable_to_determine` (or `unclear`) escape hatch so a
// classifier can refuse to guess. The pipeline treats those as soft-fail and
// keeps routing.

// Should the assistant stop and reply now, or continue downstream planning?
export const TERMINALITY_VALUES = [
  "terminal",
  "continue",
  "unable_to_determine",
] as const;
export type Terminality = (typeof TERMINALITY_VALUES)[number];

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
  "local_strong",
  "frontier_fast",
  "frontier_strong",
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
  "chat",
  "writing",
  "reasoning",
  "planning",
  "coding",
  "instruction_following",
  "unclear",
] as const;
export type ModelSpecialization = (typeof MODEL_SPECIALIZATION_VALUES)[number];

// Overall safety verdict on the latest user message. `high_risk` triggers a
// hard block in the pipeline; everything else still routes.
export const SECURITY_RISK_LEVEL_VALUES = [
  "normal",
  "suspicious",
  "high_risk",
  "unable_to_determine",
] as const;
export type SecurityRiskLevel = (typeof SECURITY_RISK_LEVEL_VALUES)[number];

// Specific safety concerns the security classifier can flag. These are
// advisory; only `risk_level === "high_risk"` actually blocks.
export const SECURITY_SIGNAL_VALUES = [
  "instruction_attack",
  "secret_or_private_data_risk",
  "unsafe_tool_or_action",
  "untrusted_content_or_code",
  "injection_or_obfuscation",
] as const;
export type SecuritySignal = (typeof SECURITY_SIGNAL_VALUES)[number];
