import { existsSync, readFileSync } from "node:fs";
import { STOCK_CLASSIFIER_NAMES, type ClassifierName } from "./classifiers.js";
import { isRecord } from "./validation.js";

export const DEFAULT_OPEN_CLASSIFY_CONFIG_PATH = "open-classify/config.json";

export interface OpenClassifyConfig {
  readonly runner?: OllamaRunnerConfig;
  readonly catalog?: string;
  readonly classifiers?: OpenClassifyClassifierConfig;
}

export interface OpenClassifyClassifierConfig {
  readonly dirs?: ReadonlyArray<string>;
  // Names of optional stock classifiers to enable. Members of
  // STOCK_CLASSIFIER_NAMES only. Stock classifiers are off by default;
  // listing one here loads the package-owned version. To customize a stock
  // classifier, run `npx open-classify eject <name>` instead — a local
  // copy in `classifiers/<name>/` overrides the stock version.
  readonly stock?: ReadonlyArray<string>;
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
  // Keyed by classifier name. Every entry must match a loaded classifier.
  readonly models?: Readonly<Record<string, string>>;
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
  return { ...config?.runner?.models };
}

export function classifierDirsFromConfig(
  config: OpenClassifyConfig | undefined,
): ReadonlyArray<string> {
  return config?.classifiers?.dirs ?? [];
}

export function stockClassifierNamesFromConfig(
  config: OpenClassifyConfig | undefined,
): ReadonlyArray<string> {
  return config?.classifiers?.stock ?? [];
}

export function validateOpenClassifyConfig(
  value: unknown,
  path = "open-classify config",
): OpenClassifyConfig {
  if (!isRecord(value)) {
    throwConfig(path, "config must be a JSON object");
  }
  ensureAllowedKeys(value, ["runner", "catalog", "classifiers"], path, "<root>");

  return {
    ...(value.runner === undefined ? {} : { runner: validateRunner(value.runner, path) }),
    ...(value.catalog === undefined ? {} : { catalog: requireString(value.catalog, path, "catalog") }),
    ...(value.classifiers === undefined
      ? {}
      : { classifiers: validateClassifiers(value.classifiers, path) }),
  };
}

function validateClassifiers(value: unknown, path: string): OpenClassifyClassifierConfig {
  if (!isRecord(value)) {
    throwConfig(path, "classifiers must be an object");
  }
  ensureAllowedKeys(value, ["dirs", "stock"], path, "classifiers");

  return {
    ...(value.dirs === undefined ? {} : { dirs: validateStringArray(value.dirs, path, "classifiers.dirs") }),
    ...(value.stock === undefined
      ? {}
      : { stock: validateEnumArray(value.stock, path, "classifiers.stock", STOCK_CLASSIFIER_NAMES) }),
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

function validateModels(value: unknown, path: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throwConfig(path, "runner.models must be an object");
  }
  const out: Record<string, string> = {};
  for (const [name, model] of Object.entries(value)) {
    out[name] = requireString(model, path, `runner.models.${name}`);
  }
  return out;
}

function validateStringArray(
  value: unknown,
  path: string,
  field: string,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throwConfig(path, `${field} must be an array`);
  }
  return value.map((item, index) => requireString(item, path, `${field}[${index}]`));
}

function validateEnumArray(
  value: unknown,
  path: string,
  field: string,
  allowedValues: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throwConfig(path, `${field} must be an array`);
  }
  const allowed = new Set(allowedValues);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const name = requireString(item, path, `${field}[${i}]`);
    if (!allowed.has(name)) {
      throwConfig(path, `${field}[${i}] "${name}" is not supported (available: ${[...allowed].join(", ")})`);
    }
    if (seen.has(name)) {
      throwConfig(path, `${field}[${i}] "${name}" is listed more than once`);
    }
    seen.add(name);
    out.push(name);
  }
  return out;
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
