import type { JsonClassifierManifest, ToolFamilyDefinition } from "./stock.js";

const BASE_PROMPT = `Return one JSON object and no other text.
The object must always include:
- reason: string, 200 characters or fewer
- confidence: number from 0 to 1
Only include optional fields declared for this classifier.`;

const HANDOFF_PROMPT = `handoff:
- Use {"kind":"route","ack_reply":"..."} when downstream work should continue and a brief acknowledgement would help.
- Use {"kind":"final","reply":"..."} only when the message can be fully answered immediately.
- Use {"kind":"block","reason_code":"..."} only for requests that should not continue downstream.`;

const ROUTING_PROMPT = `routing:
- execution_mode: "direct", "tool_assisted", or "workflow"
- model_tier: "local_fast", "local_strong", "frontier_fast", or "frontier_strong"
- specialization: "chat", "writing", "reasoning", "planning", "coding", or "instruction_following"
Use "workflow" for multi-step, stateful, or agentic work, not for a single ordinary tool call.`;

const CONTEXT_PROMPT = `context:
- {"status":"standalone"} means no prior messages are needed.
- {"status":"sufficient","include_prior_messages":N} means the visible window contains enough context and the downstream model should receive N messages before the target.
- {"status":"insufficient"} means the visible window does not contain enough context.
- {"status":"unknown"} means you cannot judge the context need.
Do not include include_prior_messages unless status is "sufficient".`;

const RESPONSE_PROMPT = `response:
- language: detected user language, such as "en", "es", or "fr"
- locale: optional BCP-47 locale when region matters, such as "en-US" or "es-MX"`;

const SAFETY_PROMPT = `safety:
- risk_level: "normal", "suspicious", "high_risk", or "unknown"
- signals: short string identifiers for the concrete safety signals
normal and unknown must use an empty signals array. suspicious and high_risk must include at least one signal.`;

const SUMMARY_PROMPT = `summary:
- target_message: compact summary of the target message, 200 characters or fewer
- conversation_window: compact summary of relevant visible conversation context, 800 characters or fewer`;

export function buildStockClassifierPrompt(manifest: JsonClassifierManifest): string {
  const sections = [
    BASE_PROMPT,
    `Classifier: ${manifest.name}
Purpose: ${manifest.purpose}`,
  ];

  if (manifest.emits.handoff) sections.push(HANDOFF_PROMPT);
  if (manifest.emits.routing) sections.push(ROUTING_PROMPT);
  if (manifest.emits.context) sections.push(CONTEXT_PROMPT);
  if (manifest.emits.tools) sections.push(toolsPrompt(manifest.tool_families));
  if (manifest.emits.response) sections.push(RESPONSE_PROMPT);
  if (manifest.emits.safety) sections.push(SAFETY_PROMPT);
  if (manifest.emits.summary) sections.push(SUMMARY_PROMPT);
  if (manifest.emits.output) {
    sections.push(
      "output:\n- Custom classifier-specific JSON. It must match the manifest output_schema when one is provided.",
    );
  }
  if (manifest.prompt?.instructions) {
    sections.push(`Classifier-specific instructions:\n${manifest.prompt.instructions}`);
  }

  sections.push(`Declared optional fields: ${declaredFields(manifest).join(", ") || "none"}.`);

  return sections.join("\n\n");
}

function toolsPrompt(families: ReadonlyArray<ToolFamilyDefinition> | undefined): string {
  if (!families || families.length === 0) {
    return `tools:
- required: boolean
- families: array of caller-defined tool family ids
required must be true exactly when families is non-empty.`;
  }
  return `tools:
- required: boolean
- families: array of these allowed ids
${families.map((family) => `  - ${family.id}: ${family.description}`).join("\n")}
required must be true exactly when families is non-empty.`;
}

function declaredFields(manifest: JsonClassifierManifest): string[] {
  return Object.entries(manifest.emits)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
}
