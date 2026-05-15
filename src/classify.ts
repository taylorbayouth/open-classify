// High-level facade for the pipeline. Builds the runner and catalog once,
// then returns two functions — classify() for the user-input/routing pass
// and inspect() for the assistant-output lean pass. Backend-agnostic: pass a
// custom `runClassifier` to bypass the bundled Ollama runner entirely.

import { loadCatalog } from "./catalog.js";
import { type RunClassifier } from "./classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
  type OpenClassifyConfig,
} from "./config.js";
import type {
  Catalog,
  InspectResult,
  PipelineResult,
} from "./manifest.js";
import {
  assertOllamaResources,
  createOllamaClassifierRunner,
  OLLAMA_DEFAULT_CATALOG_PATH,
} from "./ollama.js";
import {
  classifyOpenClassifyInput,
  inspectOpenClassifyInput,
} from "./pipeline.js";
import type { OpenClassifyInput } from "./types.js";

export type Classifier = (
  input: OpenClassifyInput,
  options?: { signal?: AbortSignal },
) => Promise<PipelineResult>;

export type Inspector = (
  input: OpenClassifyInput,
  options?: { signal?: AbortSignal },
) => Promise<InspectResult>;

export interface OpenClassify {
  readonly classify: Classifier;
  readonly inspect: Inspector;
}

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

  // Pipeline tuning, applied to every classify() / inspect() call.
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  maxConcurrency?: number;
}

export function createClassifier(
  options: CreateClassifierOptions = {},
): OpenClassify {
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

  let resourceCheck: Promise<void> | undefined;
  const ensureResources = async (): Promise<void> => {
    if (!needsResourceCheck) return;
    resourceCheck ??= assertOllamaResources({
      minTotalMemoryBytes: options.minTotalMemoryBytes,
      minAvailableMemoryBytes: options.minAvailableMemoryBytes,
    });
    await resourceCheck;
  };

  const classify: Classifier = async (input, callOptions) => {
    await ensureResources();
    return classifyOpenClassifyInput(input, {
      runClassifier,
      catalog,
      classifierTimeoutMs: options.classifierTimeoutMs,
      classifierRetryCount: options.classifierRetryCount,
      maxConcurrency: options.maxConcurrency,
      signal: callOptions?.signal,
    });
  };

  const inspect: Inspector = async (input, callOptions) => {
    await ensureResources();
    return inspectOpenClassifyInput(input, {
      runClassifier,
      classifierTimeoutMs: options.classifierTimeoutMs,
      classifierRetryCount: options.classifierRetryCount,
      maxConcurrency: options.maxConcurrency,
      signal: callOptions?.signal,
    });
  };

  return { classify, inspect };
}
