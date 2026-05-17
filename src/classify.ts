// High-level facade for the pipeline. Builds the runner, registry, and
// catalog once, then returns two functions — classify() for the
// user-input/routing pass and inspect() for the assistant-output lean pass.
// Backend-agnostic: pass a custom `runClassifier` to bypass the bundled
// Ollama runner entirely.

import { dirname, isAbsolute, resolve } from "node:path";
import { loadCatalog } from "./catalog.js";
import {
  buildClassifierRegistry,
  ClassifierManifestError,
  type ClassifierRegistryBundle,
  type RunClassifier,
} from "./classifiers.js";
import {
  classifierDirsFromConfig,
  classifierModelsFromConfig,
  DEFAULT_OPEN_CLASSIFY_CONFIG_PATH,
  loadOpenClassifyConfig,
  OpenClassifyConfigError,
  stockClassifierNamesFromConfig,
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
  // The composed registry used by this instance — mandatory built-ins,
  // enabled stock classifiers, config dirs, and any `extraClassifierDirs`
  // the caller supplied. Exposed so callers can introspect what's wired in
  // (e.g. for diagnostics or surfacing a list in their app).
  readonly registry: ClassifierRegistryBundle;
}

export interface CreateClassifierOptions {
  // Backend overrides — provide these to bypass the built-in Ollama runner
  // or the file-backed catalog loader.
  runClassifier?: RunClassifier;
  catalog?: Catalog;

  // Extra classifier directories merged into the registry alongside the
  // built-ins and any directories listed in open-classify/config.json.
  // Each directory is scanned the same way as the bundled classifiers (one
  // folder per classifier, each containing manifest.json + prompt.md).
  // Folders with a `_` prefix are skipped.
  //
  // Name collisions throw — extras cannot override the mandatory built-ins
  // (`preflight`, `model_tier`, `model_specialization`, `prompt_injection`).
  // A local classifier with the same name as a stock classifier overrides
  // the stock version (this is the "eject" pattern).
  extraClassifierDirs?: ReadonlyArray<string>;

  // Optional package-owned stock classifiers to load. Config-driven stock
  // classifiers are also loaded; duplicates are ignored.
  stockClassifierNames?: ReadonlyArray<string>;

  // Config sources. `config` wins; otherwise `configPath` is loaded; otherwise
  // `open-classify/config.json` is tried (silently optional).
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
  const configPath =
    options.config === undefined
      ? options.configPath ?? process.env.OPEN_CLASSIFY_CONFIG ?? DEFAULT_OPEN_CLASSIFY_CONFIG_PATH
      : undefined;
  const configBaseDir = configPath === undefined ? process.cwd() : dirname(resolve(configPath));

  const fileConfig =
    options.config ??
    loadOpenClassifyConfig(options.configPath, {
      optional:
        options.configPath === undefined &&
        process.env.OPEN_CLASSIFY_CONFIG === undefined,
    });

  const registryBundle = buildClassifierRegistry({
    extraDirs: uniqueStrings([
      ...classifierDirsFromConfig(fileConfig).map((dir) => resolveFromConfigBase(dir, configBaseDir)),
      ...(options.extraClassifierDirs ?? []),
    ]),
    stockClassifierNames: uniqueStrings([
      ...stockClassifierNamesFromConfig(fileConfig),
      ...(options.stockClassifierNames ?? []),
    ]),
  });

  // Cross-check `runner.models` keys against the loaded registry so a typo
  // or stale reference fails fast at construction time instead of being
  // silently ignored by the runner.
  if (fileConfig?.runner?.models !== undefined) {
    const known = new Set(registryBundle.names);
    for (const name of Object.keys(fileConfig.runner.models)) {
      if (!known.has(name)) {
        throw new OpenClassifyConfigError(
          `runner.models.${name} is not a loaded classifier (loaded: ${registryBundle.names.join(", ")})`,
        );
      }
    }
  }

  // When we own the runner, hoist the resource check to the wrapper so a
  // failure surfaces as a top-level rejection — the per-classifier fallback
  // path would otherwise mask it as five "classifier failed" entries.
  const ownsRunner = options.runClassifier === undefined;
  const needsResourceCheck = ownsRunner && !options.skipResourceCheck;

  const runClassifier =
    options.runClassifier ??
    createOllamaClassifierRunner({
      modulesByName: registryBundle.modulesByName,
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
      options.catalogPath ??
        (fileConfig?.catalog === undefined
          ? OLLAMA_DEFAULT_CATALOG_PATH
          : resolveFromConfigBase(fileConfig.catalog, configBaseDir)),
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
      registry: registryBundle.registry,
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
      registry: registryBundle.registry,
      classifierTimeoutMs: options.classifierTimeoutMs,
      classifierRetryCount: options.classifierRetryCount,
      maxConcurrency: options.maxConcurrency,
      signal: callOptions?.signal,
    });
  };

  return { classify, inspect, registry: registryBundle };
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function resolveFromConfigBase(path: string, configBaseDir: string): string {
  return isAbsolute(path) ? path : resolve(configBaseDir, path);
}

// Re-export so callers can `import { ClassifierManifestError } from "open-classify"`
// and catch directory/name collision errors from createClassifier().
export { ClassifierManifestError };
