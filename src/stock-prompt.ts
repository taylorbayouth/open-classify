import type {
  JsonClassifierManifest,
  StockJsonManifest,
  ToolDefinition,
} from "./stock.js";

const BASE_PROMPT = `Return one JSON object and no other text.
Always include:
- reason: brief string, 120 characters or fewer, justifying your decision
- confidence: JSON number float from 0.0 to 1.0 inclusive (do not use percent, string, or label).
  Use 0.9 when you are confident, 0.7 when you are reasonably sure, 0.5 when uncertain, 0.2 when guessing.
  A missing or zero confidence causes the runtime to drop your signal, so always emit a real value.`;

const PREFLIGHT_PROMPT = `Emit one of these optional fields when applicable:
- final_reply: {"reply":"..."} only for tiny terminal answers that need no downstream work.
  Do not use final_reply for drafting, rewriting, analysis, coding, research, or any generated work.
  reply must be 200 characters or fewer.
- ack_reply: {"reply":"..."} when downstream work should continue and a brief acknowledgement would help.
  reply must be 200 characters or fewer.
Omit both when the request is ambiguous or no acknowledgement is useful.
Do not answer the user except inside final_reply.reply or ack_reply.reply.`;

const ROUTING_PROMPT = `Emit one or both of these optional fields:
- model_tier: "local_fast", "local_small", "local_strong", "local_coding", "frontier_fast", "frontier_strong", or "frontier_coding"
- specialization: see the specialization enum
Omit a field rather than guessing.`;

const SAFETY_PROMPT = `Emit the safety verdict directly as top-level fields:
- decision: optional "allow", "block", or "needs_review"
- risk_level: "normal", "suspicious", "high_risk", or "unknown"
- signals: short string identifiers for concrete safety signals
normal and unknown must use an empty signals array. suspicious and high_risk must include at least one signal.
Use decision "block" only with high_risk. Use "needs_review" when the caller should clarify, escalate, or fail closed.`;

export function buildStockClassifierPrompt(manifest: JsonClassifierManifest): string {
  const sections = [
    BASE_PROMPT,
    `Classifier: ${manifest.name}\nPurpose: ${manifest.purpose}`,
  ];

  if (manifest.kind === "stock") {
    sections.push(stockSection(manifest));
  } else {
    sections.push(
      "output: required JSON value that matches this classifier's output_schema. Wrap it as {\"output\": <value>}.",
    );
  }

  return sections.join("\n\n");
}

function stockSection(manifest: StockJsonManifest): string {
  switch (manifest.name) {
    case "preflight":
      return PREFLIGHT_PROMPT;
    case "routing":
    case "model_specialization":
      return ROUTING_PROMPT;
    case "tools":
      return toolsPrompt(manifest.tools);
    case "security":
      return SAFETY_PROMPT;
  }
}

function toolsPrompt(tools: ReadonlyArray<ToolDefinition> | undefined): string {
  if (!tools || tools.length === 0) {
    return `Emit the tools verdict as top-level fields:
- tools: array of caller-defined tool ids
An empty tools array means no downstream tools are required.`;
  }
  return `Emit the tools verdict as top-level fields:
- tools: array of these allowed ids
${tools.map((tool) => `  - ${tool.id}: ${tool.description}`).join("\n")}
An empty tools array means no downstream tools are required.`;
}
