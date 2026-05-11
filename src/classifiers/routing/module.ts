// Routing classifier module. Feeds the aggregator's model resolver via the
// per-classifier results map — no envelope-slot contributions of its own.

import { DOWNSTREAM_EXECUTION_MODE_VALUES, DOWNSTREAM_MODEL_TIER_VALUES } from "../../enums.js";
import type { ClassifierModule } from "../../manifest.js";
import { ROUTING_SYSTEM_PROMPT } from "./prompt.js";
import { ROUTING_FALLBACK, validateRouting, type RoutingResult } from "./result.js";

export const routingModule: ClassifierModule<"routing", RoutingResult> = {
  name: "routing",
  version: "1.0.0",
  purpose: "Recommend the downstream execution lane and model tier.",
  systemPrompt: ROUTING_SYSTEM_PROMPT,
  validate: validateRouting,
  fallback: ROUTING_FALLBACK,
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-routing:v0.1.0",
    },
  },
  ui: {
    label: "Routing",
    optionEnum: [...DOWNSTREAM_EXECUTION_MODE_VALUES, ...DOWNSTREAM_MODEL_TIER_VALUES],
    renderer: "object",
  },
};
