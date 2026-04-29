import { readFileSync, existsSync } from "fs";
import { ModelTier } from "./schema.js";
import type { z } from "zod";

export interface ClassifierConfig {
  model: string; // format: "provider/model" e.g. "ollama/qwen3:8b" or "openai/gpt-4o-mini"
  timeout_ms: number;
  confidence_threshold: number;
  reason_max_chars: number;
  base_url?: string; // override for ollama or custom endpoints
  api_key?: string;
}

export interface RoutingConfig {
  default_model_tier: z.infer<typeof ModelTier>;
  high_risk_model_tier: z.infer<typeof ModelTier>;
  code_model_tier: z.infer<typeof ModelTier>;
  research_model_tier: z.infer<typeof ModelTier>;
  planning_model_tier: z.infer<typeof ModelTier>;
}

export interface HarnessConfig {
  classifier: ClassifierConfig;
  routing: RoutingConfig;
}

export const defaultConfig: HarnessConfig = {
  classifier: {
    model: "ollama/gemma2:9b",
    timeout_ms: 10000,
    confidence_threshold: 0.65,
    reason_max_chars: 160,
    base_url: "http://localhost:11434/v1",
  },
  routing: {
    default_model_tier: "mini",
    high_risk_model_tier: "frontier",
    code_model_tier: "mini",
    research_model_tier: "frontier",
    planning_model_tier: "mini",
  },
};

export function parseModelString(model: string): {
  provider: string;
  name: string;
} {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return { provider: "ollama", name: model };
  return {
    provider: model.slice(0, slashIdx),
    name: model.slice(slashIdx + 1),
  };
}

export function loadConfig(configPath?: string): HarnessConfig {
  const paths = configPath
    ? [configPath]
    : ["./harness.config.json", "./harness.config.local.json"];

  let fileConfig: Partial<HarnessConfig> = {};
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        fileConfig = JSON.parse(readFileSync(p, "utf-8")) as Partial<HarnessConfig>;
        break;
      } catch {
        // ignore malformed config files
      }
    }
  }

  const config: HarnessConfig = {
    classifier: {
      ...defaultConfig.classifier,
      ...fileConfig.classifier,
    },
    routing: {
      ...defaultConfig.routing,
      ...fileConfig.routing,
    },
  };

  // env var overrides
  if (process.env.HARNESS_MODEL)
    config.classifier.model = process.env.HARNESS_MODEL;
  if (process.env.HARNESS_TIMEOUT_MS)
    config.classifier.timeout_ms = Number(process.env.HARNESS_TIMEOUT_MS);
  if (process.env.HARNESS_CONFIDENCE_THRESHOLD)
    config.classifier.confidence_threshold = Number(
      process.env.HARNESS_CONFIDENCE_THRESHOLD
    );
  if (process.env.HARNESS_BASE_URL)
    config.classifier.base_url = process.env.HARNESS_BASE_URL;
  if (process.env.OPENAI_API_KEY)
    config.classifier.api_key = process.env.OPENAI_API_KEY;

  return config;
}
