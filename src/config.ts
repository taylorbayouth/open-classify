import { readFileSync, existsSync } from "fs";

export interface ClassifierConfig {
  model: string; // format: "provider/model" e.g. "ollama/gemma4:e4b-it-q4_K_M" or "openai/gpt-4o-mini"
  timeout_ms: number;
  base_url?: string;
  api_key?: string;
}

export interface ClassifiersConfig {
  awk: ClassifierConfig;
  response_path: ClassifierConfig;
  context_budget: ClassifierConfig;
  retrieval_need: ClassifierConfig;
  work_complexity: ClassifierConfig;
}

export interface RoutingConfig {
  // Below avg → UI forces awk.mode = "question", response_path = "none"
  avg_confidence_threshold: number;
  // Below min on any single classifier → same override
  min_confidence_threshold: number;
}

export interface HarnessConfig {
  classifiers: ClassifiersConfig;
  routing: RoutingConfig;
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
  model: "ollama/gemma4:e4b-it-q4_K_M",
  timeout_ms: 15000,
  base_url: "http://localhost:11434/v1",
};

export const defaultConfig: HarnessConfig = {
  classifiers: {
    awk: { ...DEFAULT_CLASSIFIER },
    response_path: { ...DEFAULT_CLASSIFIER },
    context_budget: { ...DEFAULT_CLASSIFIER },
    retrieval_need: { ...DEFAULT_CLASSIFIER },
    work_complexity: { ...DEFAULT_CLASSIFIER },
  },
  routing: {
    avg_confidence_threshold: 0.65,
    min_confidence_threshold: 0.4,
  },
};

export const DIMENSION_KEYS = [
  "awk",
  "response_path",
  "context_budget",
  "retrieval_need",
  "work_complexity",
] as const satisfies ReadonlyArray<keyof ClassifiersConfig>;

export function parseModelString(model: string): { provider: string; name: string } {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return { provider: "ollama", name: model };
  return { provider: model.slice(0, slashIdx), name: model.slice(slashIdx + 1) };
}

export function classifierModelSummary(classifiers: ClassifiersConfig): string {
  const names = Object.values(classifiers).map((c) => parseModelString(c.model).name);
  const unique = [...new Set(names)];
  return unique.join(", ");
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

  const dc = defaultConfig.classifiers;
  const fc: Partial<ClassifiersConfig> = fileConfig.classifiers ?? {};

  const config: HarnessConfig = {
    classifiers: {
      awk: { ...dc.awk, ...fc.awk },
      response_path: { ...dc.response_path, ...fc.response_path },
      context_budget: { ...dc.context_budget, ...fc.context_budget },
      retrieval_need: { ...dc.retrieval_need, ...fc.retrieval_need },
      work_complexity: { ...dc.work_complexity, ...fc.work_complexity },
    },
    routing: { ...defaultConfig.routing, ...fileConfig.routing },
  };

  // Global env var overrides apply to all 5 classifiers
  if (process.env.HARNESS_MODEL) {
    DIMENSION_KEYS.forEach((k) => {
      config.classifiers[k].model = process.env.HARNESS_MODEL!;
    });
  }
  if (process.env.HARNESS_TIMEOUT_MS) {
    DIMENSION_KEYS.forEach((k) => {
      config.classifiers[k].timeout_ms = Number(process.env.HARNESS_TIMEOUT_MS);
    });
  }
  if (process.env.HARNESS_BASE_URL) {
    DIMENSION_KEYS.forEach((k) => {
      config.classifiers[k].base_url = process.env.HARNESS_BASE_URL;
    });
  }
  if (process.env.OPENAI_API_KEY) {
    DIMENSION_KEYS.forEach((k) => {
      config.classifiers[k].api_key = process.env.OPENAI_API_KEY;
    });
  }
  if (process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD)
    config.routing.avg_confidence_threshold = Number(process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD);
  if (process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD)
    config.routing.min_confidence_threshold = Number(process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD);

  return config;
}
