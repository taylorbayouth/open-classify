// Tools classifier module. Contributes the `tool_families` envelope slot.
// The aggregator unions and dedupes across all contributors so multiple
// classifiers can independently flag the same family.

import { TOOL_FAMILY_VALUES } from "../../enums.js";
import type { ClassifierModule, Contribution } from "../../manifest.js";
import { TOOLS_SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS_FALLBACK, validateTools, type ToolsResult } from "./result.js";

const toolFamiliesContribution: Contribution<ToolsResult> = {
  slot: "tool_families",
  priority: 0,
  build: (result) => (result.families.length === 0 ? undefined : [...result.families]),
};

export const toolsModule: ClassifierModule<"tools", ToolsResult> = {
  name: "tools",
  version: "1.0.0",
  purpose: "Choose broad tool manifest families for downstream exposure.",
  systemPrompt: TOOLS_SYSTEM_PROMPT,
  validate: validateTools,
  fallback: TOOLS_FALLBACK,
  contributions: [toolFamiliesContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-tools:v0.1.0",
    },
  },
  ui: {
    label: "Tools",
    optionEnum: TOOL_FAMILY_VALUES,
    renderer: "list",
  },
};
