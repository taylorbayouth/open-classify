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

import { classifyWithOllama, loadCatalog } from "../dist/src/index.js";

const message = process.argv[2] ?? "Can you review the attached vendor contract for major risks?";

const result = await classifyWithOllama(
  {
    messages: [{ role: "user", text: message }],
    attachments:
      process.argv[2] === undefined
        ? [{ filename: "vendor-contract.pdf", mime_type: "application/pdf", size_bytes: 482_331 }]
        : [],
  },
  {
    catalog: loadCatalog("downstream-models.json"),
  },
);

console.log(JSON.stringify(result, null, 2));

if (result.decision === "short_circuit") {
  if (result.kind === "block") {
    const security = result.meta.classifiers.security;
    console.error(`\nDecision: block — ${security.safety?.risk_level}: ${security.reason}`);
  } else {
    console.error(`\nDecision: ${result.kind} — assistant should reply with: "${result.reply}"`);
  }
} else if (result.decision === "needs_review") {
  const security = result.meta.classifiers.security;
  console.error(`\nDecision: needs_review — ${security.safety?.risk_level}: ${security.reason}`);
} else {
  const { security } = result.meta.classifiers;
  console.error(
    `\nDecision: route → ${result.routing?.execution_mode} on ${result.routing?.model_tier}` +
      ` | model: ${result.model_recommendation.id} (${result.model_recommendation.params_in_billions}B params)` +
      ` | tools: ${result.tools?.families.join(", ") || "none"}` +
      ` | security: ${security.safety?.risk_level}`,
  );
}
