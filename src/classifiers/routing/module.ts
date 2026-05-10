import { DOWNSTREAM_EXECUTION_MODE_VALUES } from "../../enums.js";
import type { ClassifierModule } from "../../manifest.js";
import { ROUTING_SYSTEM_PROMPT } from "./prompt.js";
import {
  ROUTING_FALLBACK,
  validateRouting,
  type RoutingResult,
} from "./result.js";

// Routing emits execution_mode + model_tier — both feed the model resolver
// directly via results.routing in src/aggregator.ts. No Envelope slot
// contributions: the resolver's output captures the routing decision via
// model_recommendation.resolution.constraints_used.
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
    optionEnum: DOWNSTREAM_EXECUTION_MODE_VALUES,
    renderer: "object",
  },
};
