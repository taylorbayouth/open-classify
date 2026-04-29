import { readFileSync, existsSync } from "fs";

export interface ClassifierConfig {
  model: string; // format: "provider/model" e.g. "ollama/qwen3:8b" or "openai/gpt-4o-mini"
  timeout_ms: number;
  base_url?: string;
  api_key?: string;
}

export interface RoutingConfig {
  // If average confidence across the 5 classifiers falls below this, escalate
  avg_confidence_threshold: number;
  // If any single classifier confidence falls below this, escalate
  min_confidence_threshold: number;
  // Default route when classification fails entirely
  fallback_route: "local_fast" | "local_slow" | "billed_mini" | "billed_frontier";
}

export interface HarnessConfig {
  classifier: ClassifierConfig;
  routing: RoutingConfig;
}

export const defaultConfig: HarnessConfig = {
  classifier: {
    model: "ollama/qwen3:8b",
    timeout_ms: 15000,
    base_url: "http://localhost:11434/v1",
  },
  routing: {
    avg_confidence_threshold: 0.65,
    min_confidence_threshold: 0.4,
    fallback_route: "billed_mini",
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
    classifier: { ...defaultConfig.classifier, ...fileConfig.classifier },
    routing: { ...defaultConfig.routing, ...fileConfig.routing },
  };

  if (process.env.HARNESS_MODEL) config.classifier.model = process.env.HARNESS_MODEL;
  if (process.env.HARNESS_TIMEOUT_MS)
    config.classifier.timeout_ms = Number(process.env.HARNESS_TIMEOUT_MS);
  if (process.env.HARNESS_BASE_URL) config.classifier.base_url = process.env.HARNESS_BASE_URL;
  if (process.env.OPENAI_API_KEY) config.classifier.api_key = process.env.OPENAI_API_KEY;
  if (process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD)
    config.routing.avg_confidence_threshold = Number(
      process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD
    );
  if (process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD)
    config.routing.min_confidence_threshold = Number(
      process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD
    );

  return config;
}
