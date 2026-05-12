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

if (result.action === "answer") {
  console.error(`\nAction: answer — assistant should reply with: "${result.reply}"`);
} else if (result.action === "block") {
  console.error(`\nAction: block — ${result.reason.risk_level ?? result.reason.code ?? "blocked"}`);
} else if (result.action === "needs_review") {
  console.error(`\nAction: needs_review — ${result.reason.risk_level ?? "review required"}`);
} else {
  console.error(
    `\nAction: route` +
      ` | model: ${result.downstream.model_id}` +
      ` | messages: ${result.downstream.messages.length}` +
      ` | tools: ${result.downstream.tools.families.join(", ") || "none"}`,
  );
}
