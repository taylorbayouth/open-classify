import { existsSync, readFileSync } from "node:fs";
import { REGISTRY, type ClassifierName } from "./classifiers.js";
import { type AggregatorConfig } from "./manifest.js";
import { STOCK_CLASSIFIER_NAMES } from "./stock.js";
import { isRecord } from "./validation.js";

export const DEFAULT_OPEN_CLASSIFY_CONFIG_PATH = "open-classify.config.json";

export interface OpenClassifyConfig {
  readonly runner?: OllamaRunnerConfig;
  readonly catalog?: string;
  readonly aggregator?: AggregatorConfig;
}

export interface OllamaRunnerConfig {
  readonly provider: "ollama";
  readonly host?: string;
  readonly defaultModel?: string;
  readonly options?: {
    readonly temperature?: number;
    readonly top_p?: number;
    readonly seed?: number;
    readonly num_ctx?: number;
  };
  readonly models?: {
    readonly stock?: Readonly<Record<string, string>>;
    readonly custom?: Readonly<Record<string, string>>;
  };
}

export class OpenClassifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClassifyConfigError";
  }
}

export function loadOpenClassifyConfig(
  path = process.env.OPEN_CLASSIFY_CONFIG ?? DEFAULT_OPEN_CLASSIFY_CONFIG_PATH,
  options: { optional?: boolean } = {},
): OpenClassifyConfig | undefined {
  if (!existsSync(path)) {
    if (options.optional) return undefined;
    throw new OpenClassifyConfigError(`config file not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new OpenClassifyConfigError(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validateOpenClassifyConfig(parsed, path);
}

export function classifierModelsFromConfig(
  config: OpenClassifyConfig | undefined,
): Partial<Record<ClassifierName, string>> {
  const models = config?.runner?.models;
  if (!models) return {};

  return {
    ...models.stock,
    ...models.custom,
  };
}

export function validateOpenClassifyConfig(
  value: unknown,
  path = "open-classify config",
): OpenClassifyConfig {
  if (!isRecord(value)) {
    throwConfig(path, "config must be a JSON object");
  }
  ensureAllowedKeys(value, ["runner", "catalog", "aggregator"], path, "<root>");

  return {
    ...(value.runner === undefined ? {} : { runner: validateRunner(value.runner, path) }),
    ...(value.catalog === undefined ? {} : { catalog: requireString(value.catalog, path, "catalog") }),
    ...(value.aggregator === undefined ? {} : { aggregator: validateAggregator(value.aggregator, path) }),
  };
}

function validateAggregator(value: unknown, path: string): AggregatorConfig {
  if (!isRecord(value)) {
    throwConfig(path, "aggregator must be an object");
  }
  ensureAllowedKeys(value, ["certaintyThreshold", "confidenceThreshold"], path, "aggregator");
  return {
    ...(value.certaintyThreshold === undefined
      ? {}
      : { certaintyThreshold: requireUnitFloat(value.certaintyThreshold, path, "aggregator.certaintyThreshold") }),
    ...(value.confidenceThreshold === undefined
      ? {}
      : { confidenceThreshold: requireUnitFloat(value.confidenceThreshold, path, "aggregator.confidenceThreshold") }),
  };
}

function validateRunner(value: unknown, path: string): OllamaRunnerConfig {
  if (!isRecord(value)) {
    throwConfig(path, "runner must be an object");
  }
  ensureAllowedKeys(value, ["provider", "host", "defaultModel", "options", "models"], path, "runner");
  const provider = value.provider === undefined
    ? "ollama"
    : requireString(value.provider, path, "runner.provider");
  if (provider !== "ollama") {
    throwConfig(path, `runner.provider must be "ollama"`);
  }

  return {
    provider: "ollama",
    ...(value.host === undefined ? {} : { host: requireString(value.host, path, "runner.host") }),
    ...(value.defaultModel === undefined
      ? {}
      : { defaultModel: requireString(value.defaultModel, path, "runner.defaultModel") }),
    ...(value.options === undefined ? {} : { options: validateOptions(value.options, path) }),
    ...(value.models === undefined ? {} : { models: validateModels(value.models, path) }),
  };
}

function validateOptions(value: unknown, path: string): OllamaRunnerConfig["options"] {
  if (!isRecord(value)) {
    throwConfig(path, "runner.options must be an object");
  }
  ensureAllowedKeys(value, ["temperature", "top_p", "seed", "num_ctx"], path, "runner.options");
  return {
    ...(value.temperature === undefined
      ? {}
      : { temperature: requireNumber(value.temperature, path, "runner.options.temperature") }),
    ...(value.top_p === undefined
      ? {}
      : { top_p: requireNumber(value.top_p, path, "runner.options.top_p") }),
    ...(value.seed === undefined
      ? {}
      : { seed: requireNumber(value.seed, path, "runner.options.seed") }),
    ...(value.num_ctx === undefined
      ? {}
      : { num_ctx: requireNumber(value.num_ctx, path, "runner.options.num_ctx") }),
  };
}

function validateModels(value: unknown, path: string): NonNullable<OllamaRunnerConfig["models"]> {
  if (!isRecord(value)) {
    throwConfig(path, "runner.models must be an object");
  }
  ensureAllowedKeys(value, ["stock", "custom"], path, "runner.models");
  return {
    ...(value.stock === undefined
      ? {}
      : { stock: validateModelMap(value.stock, path, "runner.models.stock", stockClassifierNames()) }),
    ...(value.custom === undefined
      ? {}
      : { custom: validateModelMap(value.custom, path, "runner.models.custom", customClassifierNames()) }),
  };
}

function validateModelMap(
  value: unknown,
  path: string,
  field: string,
  allowedNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throwConfig(path, `${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [name, model] of Object.entries(value)) {
    if (!allowedNames.has(name)) {
      throwConfig(path, `${field}.${name} is not a known classifier`);
    }
    out[name] = requireString(model, path, `${field}.${name}`);
  }
  return out;
}

function stockClassifierNames(): ReadonlySet<string> {
  return new Set(STOCK_CLASSIFIER_NAMES);
}

function customClassifierNames(): ReadonlySet<string> {
  return new Set(
    REGISTRY
      .filter((classifier) => classifier.kind === "custom")
      .map((classifier) => classifier.name),
  );
}

function requireString(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throwConfig(path, `${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, path: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throwConfig(path, `${field} must be a finite number`);
  }
  return value;
}

function requireUnitFloat(value: unknown, path: string, field: string): number {
  const number = requireNumber(value, path, field);
  if (number < 0 || number > 1) {
    throwConfig(path, `${field} must be a finite number between 0 and 1 inclusive`);
  }
  return number;
}

function ensureAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throwConfig(path, `${field}.${key} is not a supported field`);
    }
  }
}

function throwConfig(path: string, message: string): never {
  throw new OpenClassifyConfigError(`${path}: ${message}`);
}
