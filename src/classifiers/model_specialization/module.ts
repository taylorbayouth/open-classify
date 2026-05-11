// Model specialization classifier module. Feeds the aggregator's resolver
// via the results map — no envelope-slot contributions of its own.

import { MODEL_SPECIALIZATION_VALUES } from "../../enums.js";
import type { ClassifierModule } from "../../manifest.js";
import { MODEL_SPECIALIZATION_SYSTEM_PROMPT } from "./prompt.js";
import {
  MODEL_SPECIALIZATION_FALLBACK,
  validateModelSpecialization,
  type ModelSpecializationResult,
} from "./result.js";

export const modelSpecializationModule: ClassifierModule<
  "model_specialization",
  ModelSpecializationResult
> = {
  name: "model_specialization",
  version: "1.0.0",
  purpose: "Choose the model or prompt specialization best suited to the message.",
  systemPrompt: MODEL_SPECIALIZATION_SYSTEM_PROMPT,
  validate: validateModelSpecialization,
  fallback: MODEL_SPECIALIZATION_FALLBACK,
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-model-specialization:v0.1.0",
    },
  },
  ui: {
    label: "Model specialization",
    optionEnum: MODEL_SPECIALIZATION_VALUES,
    renderer: "enum",
  },
};
