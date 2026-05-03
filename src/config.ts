/**
 * Config loading for the harness.
 *
 * Each of the 5 sub-classifiers has its own {@link ClassifierConfig}, so they
 * can run on different models if desired. {@link loadConfig} layers values in
 * this order, last-wins:
 *
 *   1. Built-in defaults ({@link defaultConfig})
 *   2. `harness.config.json`, then `harness.config.local.json` (first match)
 *   3. Environment variables (`HARNESS_MODEL`, `HARNESS_TIMEOUT_MS`,
 *      `HARNESS_BASE_URL`, `OPENAI_API_KEY`,
 *      `HARNESS_AVG_CONFIDENCE_THRESHOLD`, `HARNESS_MIN_CONFIDENCE_THRESHOLD`)
 *
 * Env-var overrides apply uniformly to all 5 classifiers.
 */
import { readFileSync, existsSync } from "fs";

/** Per-classifier config. One of these per sub-classifier. */
export interface ClassifierConfig {
  /** `"<provider>/<model>"`, e.g. `"ollama/gemma4:e4b-it-q4_K_M"` or `"openai/gpt-4o-mini"`. Provider defaults to `"ollama"` if no slash is present. */
  model: string;
  /** Hard timeout for the model call, in milliseconds. */
  timeout_ms: number;
  /** Override base URL (e.g. a remote Ollama). Ignored for non-Ollama providers. */
  base_url?: string;
  /** Override API key. If unset, the OpenAI client falls back to `process.env.OPENAI_API_KEY`. */
  api_key?: string;
}

/** Container for the 5 per-dimension classifier configs. */
export interface ClassifiersConfig {
  awk: ClassifierConfig;
  response_path: ClassifierConfig;
  context_budget: ClassifierConfig;
  retrieval_need: ClassifierConfig;
  work_complexity: ClassifierConfig;
}

/**
 * Confidence thresholds. There is no router — these drive a UI-side override:
 * when the average across the 5 classifiers, or any single classifier,
 * dips below threshold, the surface forces `awk.mode = "question"` and
 * `response_path = "none"` instead of acting on a low-confidence read.
 */
export interface RoutingConfig {
  /** Average across the 5 classifiers. Below this → UI override. */
  avg_confidence_threshold: number;
  /** Per-classifier floor. Any one classifier below this → same override. */
  min_confidence_threshold: number;
}

/** Top-level harness config. The shape `loadConfig` returns. */
export interface HarnessConfig {
  classifiers: ClassifiersConfig;
  routing: RoutingConfig;
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
  model: "ollama/gemma4:e4b-it-q4_K_M",
  timeout_ms: 15000,
  base_url: "http://localhost:11434/v1",
};

/** Built-in defaults. Used as the base layer in {@link loadConfig}. */
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

/**
 * Tuple of the 5 dimension keys, in canonical order. Use this for iterating
 * the classifiers config without hardcoding the list at the call site.
 */
export const DIMENSION_KEYS = [
  "awk",
  "response_path",
  "context_budget",
  "retrieval_need",
  "work_complexity",
] as const satisfies ReadonlyArray<keyof ClassifiersConfig>;

/**
 * Splits a `"provider/model"` string into its parts. If no slash is present,
 * the provider defaults to `"ollama"` and the whole string is the model name.
 *
 * @example
 * parseModelString("openai/gpt-4o-mini") // { provider: "openai", name: "gpt-4o-mini" }
 * parseModelString("qwen3:8b")           // { provider: "ollama", name: "qwen3:8b" }
 */
export function parseModelString(model: string): { provider: string; name: string } {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return { provider: "ollama", name: model };
  return { provider: model.slice(0, slashIdx), name: model.slice(slashIdx + 1) };
}

/**
 * Compact, human-readable summary of which models the 5 classifiers are
 * using. Deduplicates so a uniform setup renders as a single name.
 */
export function classifierModelSummary(classifiers: ClassifiersConfig): string {
  const names = Object.values(classifiers).map((c) => parseModelString(c.model).name);
  const unique = [...new Set(names)];
  return unique.join(", ");
}

/**
 * Loads and merges harness config from defaults, file, and environment.
 *
 * @param configPath - Optional explicit path. If omitted, tries
 *   `./harness.config.json` then `./harness.config.local.json`.
 * @returns Fully resolved {@link HarnessConfig}. Always succeeds — malformed
 *   config files are silently ignored and the next layer is used.
 */
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
