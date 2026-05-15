// High-level facade for the pipeline. Builds the runner and catalog once,
// then returns a closure callers can invoke many times without re-loading
// config or the catalog from disk. Backend-agnostic: pass a custom
// `runClassifier` to bypass the bundled Ollama runner entirely.

import { loadCatalog } from "./catalog.js";
import { type RunClassifier } from "./classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
  type OpenClassifyConfig,
} from "./config.js";
import type { AggregatorConfig, Catalog, PipelineResult } from "./manifest.js";
import {
  assertOllamaResources,
  createOllamaClassifierRunner,
  OLLAMA_DEFAULT_CATALOG_PATH,
} from "./ollama.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type { OpenClassifyInput } from "./types.js";

export type Classifier = (
  input: OpenClassifyInput,
  options?: { signal?: AbortSignal },
) => Promise<PipelineResult>;

export interface CreateClassifierOptions {
  // Backend overrides — provide these to bypass the built-in Ollama runner
  // or the file-backed catalog loader.
  runClassifier?: RunClassifier;
  catalog?: Catalog;

  // Config sources. `config` wins; otherwise `configPath` is loaded; otherwise
  // `open-classify.config.json` is tried (silently optional).
  config?: OpenClassifyConfig;
  configPath?: string;
  catalogPath?: string;

  // Ollama-runner knobs. Ignored when `runClassifier` is provided.
  skipResourceCheck?: boolean;
  minAvailableMemoryBytes?: number;
  minTotalMemoryBytes?: number;
  fetch?: typeof fetch;

  // Pipeline tuning, applied to every classify() call.
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  maxConcurrency?: number;
  aggregator?: AggregatorConfig;
}

export function createClassifier(
  options: CreateClassifierOptions = {},
): Classifier {
  const fileConfig =
    options.config ??
    loadOpenClassifyConfig(options.configPath, {
      optional:
        options.configPath === undefined &&
        process.env.OPEN_CLASSIFY_CONFIG === undefined,
    });

  // When we own the runner, hoist the resource check to the wrapper so a
  // failure surfaces as a top-level rejection — the per-classifier fallback
  // path would otherwise mask it as five "classifier failed" entries.
  const ownsRunner = options.runClassifier === undefined;
  const needsResourceCheck = ownsRunner && !options.skipResourceCheck;

  const runClassifier =
    options.runClassifier ??
    createOllamaClassifierRunner({
      host: fileConfig?.runner?.host,
      defaultModel: fileConfig?.runner?.defaultModel,
      models: classifierModelsFromConfig(fileConfig),
      options: fileConfig?.runner?.options,
      skipResourceCheck: needsResourceCheck ? true : options.skipResourceCheck,
      fetch: options.fetch,
    });

  const catalog =
    options.catalog ??
    loadCatalog(
      options.catalogPath ?? fileConfig?.catalog ?? OLLAMA_DEFAULT_CATALOG_PATH,
    );

  const aggregator = options.aggregator ?? fileConfig?.aggregator;

  let resourceCheck: Promise<void> | undefined;

  return async (input, callOptions) => {
    if (needsResourceCheck) {
      resourceCheck ??= assertOllamaResources({
        minTotalMemoryBytes: options.minTotalMemoryBytes,
        minAvailableMemoryBytes: options.minAvailableMemoryBytes,
      });
      await resourceCheck;
    }
    return classifyOpenClassifyInput(input, {
      runClassifier,
      catalog,
      classifierTimeoutMs: options.classifierTimeoutMs,
      classifierRetryCount: options.classifierRetryCount,
      maxConcurrency: options.maxConcurrency,
      aggregator,
      signal: callOptions?.signal,
    });
  };
}
