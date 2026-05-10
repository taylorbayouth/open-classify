import { TOOL_FAMILY_VALUES } from "../../enums.js";
import type { ClassifierModule, Contribution } from "../../manifest.js";
import { TOOL_FAMILY_NEED_SYSTEM_PROMPT } from "./prompt.js";
import {
  TOOLS_FALLBACK,
  validateTools,
  type ToolsResult,
} from "./result.js";

// Contributes the broad tool families to expose downstream. The caller maps
// family names to concrete tool ids in their own registry. When families is
// empty (needed=false), this contributor abstains.
const toolFamiliesContribution: Contribution<ToolsResult> = {
  slot: "tool_families",
  priority: 0,
  build: (result) =>
    result.families.length > 0 ? [...result.families] : undefined,
};

export const toolsModule: ClassifierModule<"tools", ToolsResult> = {
  name: "tools",
  version: "1.0.0",
  purpose: "Choose broad tool manifest families for downstream exposure.",
  systemPrompt: TOOL_FAMILY_NEED_SYSTEM_PROMPT,
  validate: validateTools,
  fallback: TOOLS_FALLBACK,
  contributions: [toolFamiliesContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-tool-family-need:v0.1.0",
    },
  },
  ui: {
    label: "Tools",
    optionEnum: TOOL_FAMILY_VALUES,
    renderer: "list",
  },
};
