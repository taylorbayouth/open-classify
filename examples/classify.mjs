// End-to-end classification example.
//
// Run after `npm run setup` (which builds dist/ and confirms Ollama + the base
// model are ready):
//
//   node examples/classify.mjs
//
// To classify a different message, pass it as the first argument:
//
//   node examples/classify.mjs "Find time with Robert next week and draft the email."

import {
  classifyWithOllama,
  EXAMPLE_DOWNSTREAM_MODEL_CONFIG,
} from "../dist/src/index.js";

const message = process.argv[2] ?? "Can you review the attached vendor contract for major risks?";

const result = await classifyWithOllama({
  messages: [{ role: "user", text: message }],
  attachments:
    process.argv[2] === undefined
      ? [{ filename: "vendor-contract.pdf", mime_type: "application/pdf", size_bytes: 482_331 }]
      : [],
}, {
  downstreamModels: EXAMPLE_DOWNSTREAM_MODEL_CONFIG,
});

console.log(JSON.stringify(result, null, 2));

if (result.decision === "terminal") {
  console.error(`\nDecision: terminal — assistant should reply with: "${result.reply}"`);
} else if (result.decision === "block") {
  console.error(
    `\nDecision: block — ${result.security.risk_level}: ${result.security.reason}`,
  );
} else {
  const { routing, tools, security } = result.classifiers;
  console.error(
    `\nDecision: route → ${routing.execution_mode} on ${routing.model_tier}` +
      ` | model: ${result.handoff.model.model ?? "(unresolved)"}` +
      ` | tools: ${tools.families.join(", ") || "none"}` +
      ` | security: ${security.risk_level}`,
  );
}
