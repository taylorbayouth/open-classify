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

console.error(
  `\nAction: ${result.action}` +
    ` | model: ${result.model_id}` +
    ` | tools: ${result.tools.join(", ") || "none"}` +
    ` | certainty min=${result.min_certainty.toFixed(2)} avg=${result.avg_certainty.toFixed(2)}`,
);

if (result.action === "reply") {
  console.error(`Preflight suggested a final reply: "${result.reply?.text}"`);
}
if (result.action === "block") {
  console.error(`Blocked: ${result.block_reason}`);
  if (result.block_reason === "prompt_injection") {
    console.error(`Injection risk: ${result.prompt_injection?.risk_level}`);
  }
}
