// High-level facade for the pipeline. Builds the runner, registry, and
// catalog once, then returns two functions — classify() for the
// user-input/routing pass and inspect() for the assistant-output lean pass.
// Backend-agnostic: pass a custom `runClassifier` to bypass the bundled
// Ollama runner entirely.

import { loadCatalog } from "./catalog.js";
import {
  buildClassifierRegistry,
  ClassifierManifestError,
  type ClassifierRegistryBundle,
  type RunClassifier,
} from "./classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
  OpenClassifyConfigError,
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
  // The composed registry used by this instance — built-ins plus any
  // `extraClassifierDirs` the caller supplied. Exposed so callers can
  // introspect what's wired in (e.g. for diagnostics or surfacing a list
  // in their app).
  readonly registry: ClassifierRegistryBundle;
}

export interface CreateClassifierOptions {
  // Backend overrides — provide these to bypass the built-in Ollama runner
  // or the file-backed catalog loader.
  runClassifier?: RunClassifier;
  catalog?: Catalog;

  // Extra classifier directories merged into the registry alongside the
  // built-ins. Each directory is scanned the same way as the bundled
  // classifiers (one folder per classifier, each containing manifest.json
  // + prompt.md). A name collision between two ACTIVE classifiers throws
  // ClassifierManifestError — so disabling a built-in frees its name for
  // an extra to take over (that's the "copy a built-in to customize it"
  // workflow).
  //
  // Use this to keep your own classifiers inside your project so they
  // survive `npm install` / `npm update` of this package.
  extraClassifierDirs?: ReadonlyArray<string>;

  // Names of classifiers to skip — merged with the config-file equivalent
  // (`classifiers.disabled`) and with the package's default-disabled list.
  // Every name must exist in the loaded set (built-in or extra), or the
  // call throws.
  disabledClassifiers?: ReadonlyArray<string>;

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

  const disabledClassifiers = [
    ...(fileConfig?.classifiers?.disabled ?? []),
    ...(options.disabledClassifiers ?? []),
  ];

  const registryBundle = buildClassifierRegistry({
    extraDirs: options.extraClassifierDirs,
    disabledClassifiers,
  });

  // Cross-check `runner.models` keys against the active registry so a typo
  // or stale reference fails fast at construction time instead of being
  // silently ignored by the runner.
  if (fileConfig?.runner?.models !== undefined) {
    const known = new Set(registryBundle.names);
    for (const name of Object.keys(fileConfig.runner.models)) {
      if (!known.has(name)) {
        throw new OpenClassifyConfigError(
          `runner.models.${name} is not an active classifier (active: ${registryBundle.names.join(", ")})`,
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

// Re-export so callers can `import { ClassifierManifestError } from "open-classify"`
// and catch directory/name collision errors from createClassifier().
export { ClassifierManifestError };
