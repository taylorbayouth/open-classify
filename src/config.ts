/**
 * Single source of truth for every user-configurable setting in the harness.
 *
 * {@link loadConfig} layers values in this order, last-wins:
 *
 *   1. Built-in defaults ({@link defaultConfig})
 *   2. `harness.config.json`, then `harness.config.local.json` (first match)
 *   3. Environment variables (see table below)
 *
 * Env-var overrides for classifier fields apply uniformly to all classifiers.
 *
 * | Section            | Key                          | Env var                            |
 * | ------------------ | ---------------------------- | ---------------------------------- |
 * | `classifiers.<dim>`| `model`                      | `HARNESS_MODEL`                    |
 * | `classifiers.<dim>`| `timeout_ms`                 | `HARNESS_TIMEOUT_MS`               |
 * | `classifiers.<dim>`| `base_url`                   | `HARNESS_BASE_URL`                 |
 * | `classifiers.<dim>`| `api_key`                    | `OPENAI_API_KEY`                   |
 * | `classifiers.<dim>`| `think`                      | `HARNESS_THINK`                    |
 * | `classifiers.<dim>`| `prompt`                     | (file only — multi-line)           |
 * | `routing`          | `avg_confidence_threshold`   | `HARNESS_AVG_CONFIDENCE_THRESHOLD` |
 * | `routing`          | `min_confidence_threshold`   | `HARNESS_MIN_CONFIDENCE_THRESHOLD` |
 * | `server`           | `max_body_bytes`             | `HARNESS_MAX_BODY_BYTES`           |
 *
 * Defaults live on {@link defaultConfig}. README.md mirrors this table for users.
 */
import { readFileSync, existsSync } from "fs";
import { DIMENSION_KEYS, type DimensionName } from "./classifiers.js";

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
  /** Enable extended reasoning (thinking) mode. Slower but more accurate; only supported by some models (e.g. Ollama think-capable models). Defaults to `false`. */
  think: boolean;
  /** Override the registry's default prompt for this classifier. Useful for tuning without editing source. The override must still instruct the model to return JSON matching the dimension's schema. */
  prompt?: string;
}

/** Per-dimension classifier configs. One entry per registry key. */
export type ClassifiersConfig = Record<DimensionName, ClassifierConfig>;

/**
 * Confidence thresholds. There is no router — these drive a UI-side override:
 * when the average across the classifiers, or any single classifier,
 * dips below threshold, the surface forces `awk.mode = "question"` and
 * `response_path = "none"` instead of acting on a low-confidence read.
 */
export interface RoutingConfig {
  /** Average across the classifiers. Below this → UI override. */
  avg_confidence_threshold: number;
  /** Per-classifier floor. Any one classifier below this → same override. */
  min_confidence_threshold: number;
}

/**
 * HTTP-server-only settings. These do NOT affect the library or CLI; they
 * apply purely at the network boundary in `server.ts`. The library
 * intentionally has no per-input length cap — callers decide what they want
 * to classify, and the model's context window is the eventual ceiling.
 *
 * `max_body_bytes` exists strictly as a DoS guard for operators who run the
 * HTTP server publicly. Set it generously (or very large) if you classify
 * long documents over HTTP; set it small if you only ever classify short
 * messages and want a tighter abuse limit.
 */
export interface ServerConfig {
  /** Maximum POST body size (bytes) the HTTP server will read before responding 413. */
  max_body_bytes: number;
}

/** Top-level harness config. The shape `loadConfig` returns. */
export interface HarnessConfig {
  classifiers: ClassifiersConfig;
  routing: RoutingConfig;
  server: ServerConfig;
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
  model: "ollama/gemma4:e4b-it-q4_K_M",
  timeout_ms: 60000,
  base_url: "http://localhost:11434/v1",
  think: false,
};

/** Built-in defaults. Used as the base layer in {@link loadConfig}. */
export const defaultConfig: HarnessConfig = {
  classifiers: Object.fromEntries(
    DIMENSION_KEYS.map((d) => [d, { ...DEFAULT_CLASSIFIER }])
  ) as ClassifiersConfig,
  routing: {
    avg_confidence_threshold: 0.65,
    min_confidence_threshold: 0.4,
  },
  server: {
    // 1 MiB. Generous default for prose/code/transcripts; operators running
    // the HTTP server publicly can tighten or loosen this freely.
    max_body_bytes: 1 * 1024 * 1024,
  },
};

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
 * Compact, human-readable summary of which models the classifiers are using.
 * Deduplicates so a uniform setup renders as a single name.
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
    classifiers: Object.fromEntries(
      DIMENSION_KEYS.map((d) => [d, { ...dc[d], ...fc[d] }])
    ) as ClassifiersConfig,
    routing: { ...defaultConfig.routing, ...fileConfig.routing },
    server: { ...defaultConfig.server, ...fileConfig.server },
  };

  // Validate server.max_body_bytes — a junk value here would either disable
  // the DoS guard or reject every request, so fall back loudly.
  if (
    typeof config.server.max_body_bytes !== "number" ||
    !Number.isFinite(config.server.max_body_bytes) ||
    config.server.max_body_bytes <= 0
  ) {
    process.stderr.write(
      `[config] server.max_body_bytes must be a positive number; got ${JSON.stringify(
        config.server.max_body_bytes
      )}. Falling back to default ${defaultConfig.server.max_body_bytes}.\n`
    );
    config.server.max_body_bytes = defaultConfig.server.max_body_bytes;
  }

  // Global env var overrides apply to all classifiers
  const setAll = <K extends keyof ClassifierConfig>(key: K, value: ClassifierConfig[K]) => {
    DIMENSION_KEYS.forEach((d: DimensionName) => {
      config.classifiers[d][key] = value;
    });
  };

  if (process.env.HARNESS_MODEL) setAll("model", process.env.HARNESS_MODEL);
  if (process.env.HARNESS_TIMEOUT_MS) setAll("timeout_ms", Number(process.env.HARNESS_TIMEOUT_MS));
  if (process.env.HARNESS_BASE_URL) setAll("base_url", process.env.HARNESS_BASE_URL);
  if (process.env.OPENAI_API_KEY) setAll("api_key", process.env.OPENAI_API_KEY);
  if (process.env.HARNESS_THINK !== undefined) {
    setAll("think", process.env.HARNESS_THINK === "true" || process.env.HARNESS_THINK === "1");
  }

  if (process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD)
    config.routing.avg_confidence_threshold = Number(process.env.HARNESS_AVG_CONFIDENCE_THRESHOLD);
  if (process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD)
    config.routing.min_confidence_threshold = Number(process.env.HARNESS_MIN_CONFIDENCE_THRESHOLD);
  if (process.env.HARNESS_MAX_BODY_BYTES) {
    const n = Number(process.env.HARNESS_MAX_BODY_BYTES);
    if (Number.isFinite(n) && n > 0) config.server.max_body_bytes = n;
  }

  return config;
}
