import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JsonClassifierManifest,
  StockJsonManifest,
  ToolDefinition,
} from "./stock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOCK_PROMPTS_DIR = join(__dirname, "classifiers", "stock", "prompts");

export function buildStockClassifierPrompt(manifest: JsonClassifierManifest): string {
  const sections = [
    promptMarkdown("base.md"),
    promptMarkdown("reason.md"),
    promptMarkdown("confidence.md"),
    renderTemplate(promptMarkdown("classifier-header.md"), {
      classifier_name: manifest.name,
      classifier_purpose: manifest.purpose,
    }),
  ];

  if (manifest.kind === "stock") {
    sections.push(stockSection(manifest));
  } else {
    sections.push(promptMarkdown("custom-output.md"));
  }

  return sections.join("\n\n");
}

function stockSection(manifest: StockJsonManifest): string {
  return renderTemplate(promptMarkdown(`${manifest.name}.md`), {
    allowed_tools: renderAllowedTools(manifest.tools),
    preflight_output: promptMarkdown("preflight-output.md"),
    routing_output: promptMarkdown("routing-output.md"),
    security_output: promptMarkdown("security-output.md"),
    specialty: promptMarkdown("specialty.md"),
    tier: promptMarkdown("tier.md"),
    tools_output: promptMarkdown("tools-output.md"),
  });
}

function renderAllowedTools(tools: ReadonlyArray<ToolDefinition> | undefined): string {
  if (!tools || tools.length === 0) {
    return "No downstream tools are available.";
  }
  return [
    "Allowed tool ids:",
    "",
    ...tools.map((tool) => `- ${tool.id}: ${tool.description}`),
  ].join("\n");
}

function promptMarkdown(filename: string): string {
  return readFileSync(join(STOCK_PROMPTS_DIR, filename), "utf8").trim();
}

function renderTemplate(template: string, slots: Record<string, string>): string {
  let rendered = template;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = rendered.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => {
      const value = slots[name];
      if (value === undefined) {
        throw new Error(`missing prompt slot: ${match}`);
      }
      return value;
    });
    if (next === rendered) return rendered;
    rendered = next;
  }
  throw new Error("prompt template slots are nested too deeply");
}
