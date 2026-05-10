import { MODEL_SPECIALIZATION_VALUES } from "../../enums.js";
import type { ClassifierModule } from "../../manifest.js";
import { MODEL_SPECIALIZATION_SYSTEM_PROMPT } from "./prompt.js";
import {
  MODEL_SPECIALIZATION_FALLBACK,
  validateModelSpecialization,
  type ModelSpecializationResult,
} from "./result.js";

// Feeds the model resolver directly via results.model_specialization in
// src/aggregator.ts. No Envelope slot contributions: the resolver's output
// captures the choice on model_recommendation.resolution.constraints_used.
export const modelSpecializationModule: ClassifierModule<
  "model_specialization",
  ModelSpecializationResult
> = {
  name: "model_specialization",
  version: "1.0.0",
  purpose:
    "Choose the model or prompt specialization best suited to the message.",
  systemPrompt: MODEL_SPECIALIZATION_SYSTEM_PROMPT,
  validate: validateModelSpecialization,
  fallback: MODEL_SPECIALIZATION_FALLBACK,
  backends: {
    ollama: {
      adapterModel: "open-classify-model-specialization:v0.1.0",
    },
  },
  ui: {
    label: "Model Specialization",
    optionEnum: MODEL_SPECIALIZATION_VALUES,
    renderer: "enum",
  },
};
