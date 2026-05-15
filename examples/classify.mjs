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

import { createClassifier, loadCatalog } from "../dist/src/index.js";

const message = process.argv[2] ?? "Can you review the attached vendor contract for major risks?";

const { classify } = createClassifier({
  catalog: loadCatalog("downstream-models.json"),
});

const result = await classify({
  messages: [{ role: "user", text: message }],
});

console.log(JSON.stringify(result, null, 2));

const { min, avg } = result.audit.meta.certainty;
console.error(
  `\nAction: route` +
    ` | model: ${result.downstream.model_id}` +
    ` | tools: ${result.downstream.tools.tools.join(", ") || "none"}` +
    ` | certainty min=${min.toFixed(2)} avg=${avg.toFixed(2)}`,
);

if (result.audit.final_reply) {
  console.error(`A classifier suggested a final reply: "${result.audit.final_reply.text}"`);
}
if (result.audit.prompt_injection?.risk_level === "high_risk" ||
    result.audit.prompt_injection?.risk_level === "unknown") {
  console.error(`Prompt-injection risk: ${result.audit.prompt_injection.risk_level}`);
}
