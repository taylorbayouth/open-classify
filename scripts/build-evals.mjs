#!/usr/bin/env node
// Build training/evals/<classifier>.jsonl by joining:
//   - training/scenarios.jsonl     (canonical scenarios: title, messages, attachments)
//   - training/eval-labels/<classifier>.jsonl  (per-classifier labels keyed by title)
//   - src/classifiers/<classifier>/manifest.json (output contract)
//
// Each classifier's eval set = the subset of scenarios that has labels for it.
// Adding a new classifier means dropping a new eval-labels/<name>.jsonl file
// (and a guide). No need to duplicate the scenarios.
//
// Usage:
//   node scripts/build-evals.mjs                    # build all classifiers
//   node scripts/build-evals.mjs preflight tools    # build specific ones

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SYSTEM = "Return only valid JSON for this classifier. Do not answer the user.";
const ajv = new Ajv({ allErrors: true, strict: false });

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function compact(obj) {
  return JSON.stringify(obj);
}

function formatWindow(messages, attachments) {
  const lines = ["Conversation window:"];
  for (const [i, msg] of messages.entries()) {
    const tag = i === messages.length - 1 ? "target" : "context";
    lines.push(`Message ${i + 1} (${tag}):`);
    lines.push(`role: ${msg.role}`);
    lines.push("text:");
    lines.push(msg.text);
    lines.push("");
  }
  lines.push("Attachments:");
  if (!attachments || attachments.length === 0) {
    lines.push("none");
  } else {
    for (const [i, att] of attachments.entries()) {
      lines.push(`- Attachment ${i + 1}:`);
      if (att.filename) lines.push(`  filename: ${att.filename}`);
      if (att.mime_type) lines.push(`  mime_type: ${att.mime_type}`);
      if (att.size_bytes != null) lines.push(`  size_bytes: ${att.size_bytes}`);
    }
  }
  return lines.join("\n");
}

const scenarios = readJsonl(join(ROOT, "training/scenarios.jsonl"));
const scenarioByTitle = new Map(scenarios.map((s) => [s.title, s]));

const labelsDir = join(ROOT, "training/eval-labels");
const classifiersDir = join(ROOT, "src/classifiers");
const requested = process.argv.slice(2);
const allClassifiers = readdirSync(labelsDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => basename(f, ".jsonl"));
const classifiers = requested.length > 0 ? requested : allClassifiers;

let totalRows = 0;
const errors = [];

for (const classifier of classifiers) {
  const labelsPath = join(labelsDir, `${classifier}.jsonl`);
  const outPath = join(ROOT, `training/evals/${classifier}.jsonl`);
  const manifest = JSON.parse(
    readFileSync(join(classifiersDir, classifier, "manifest.json"), "utf8"),
  );
  const labels = readJsonl(labelsPath);

  const rows = [];
  for (const { title, output } of labels) {
    const scenario = scenarioByTitle.get(title);
    if (!scenario) {
      errors.push(`${classifier}: no scenario found for title ${JSON.stringify(title)}`);
      continue;
    }
    const validationError = validateOutput(manifest, output);
    if (validationError) {
      errors.push(`${classifier}: ${JSON.stringify(title)} invalid output: ${validationError}`);
      continue;
    }
    rows.push({
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: formatWindow(scenario.messages, scenario.attachments ?? []),
        },
        { role: "assistant", content: compact(output) },
      ],
    });
  }

  writeFileSync(outPath, rows.map((r) => compact(r)).join("\n") + "\n");
  console.log(`  ${classifier}: ${rows.length} rows → training/evals/${classifier}.jsonl`);
  totalRows += rows.length;
}

console.log(`\nbuilt ${totalRows} rows across ${classifiers.length} classifiers`);
if (errors.length > 0) {
  console.error("\nERRORS:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

function validateOutput(manifest, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return "output must be an object";
  }
  for (const key of Object.keys(output)) {
    if (key !== "reason" && key !== "confidence" && !manifest.emits?.[key]) {
      return `${key} is not declared in emits`;
    }
  }
  if (typeof output.reason !== "string") return "reason must be a string";
  if (typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1) {
    return "confidence must be a number from 0 to 1";
  }
  if (manifest.emits?.output) {
    if (!manifest.output_schema) return "output_schema is required when output is emitted";
    const validate = ajv.compile(manifest.output_schema);
    if (!validate(output.output)) return ajv.errorsText(validate.errors, { dataVar: "output" });
  }
  return null;
}
