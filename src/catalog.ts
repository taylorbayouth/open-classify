// Strict loader and validator for `downstream-models.json` — the authoritative
// source for every downstream model's metadata (id, axis fit, parameter
// count, context window, and optional pricing). Classifiers never emit any
// of these fields; the aggregator's model resolver reads them directly from a
// loaded `Catalog`.
//
// "Strict" means: missing file, unparseable JSON, malformed entry, or any
// required field missing/of the wrong type throws a `CatalogError`. Pipelines
// that initialize without a valid catalog fail fast at startup instead of
// silently degrading. The `default` field must reference an existing model id.

import { readFileSync, statSync } from "node:fs";
import {
  DOWNSTREAM_EXECUTION_MODE_VALUES,
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
} from "./enums.js";
import type { Catalog, CatalogEntry } from "./manifest.js";

export class CatalogError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "CatalogError";
    this.path = path;
  }
}

// Top-level entry point: read the file, parse, validate. Throws CatalogError
// on every failure path.
export function loadCatalog(configPath: string): Catalog {
  if (!isFile(configPath)) {
    throw new CatalogError(`catalog file not found`, configPath);
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new CatalogError(
      `failed to read catalog: ${error instanceof Error ? error.message : String(error)}`,
      configPath,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CatalogError(
      `failed to parse catalog JSON: ${error instanceof Error ? error.message : String(error)}`,
      configPath,
    );
  }
  return validateCatalog(parsed, configPath);
}

// Validate an already-parsed object. Exposed separately so tests can pass
// in-memory objects without round-tripping through disk.
export function validateCatalog(value: unknown, path?: string): Catalog {
  if (!isRecord(value)) {
    throw new CatalogError("catalog must be a JSON object", path);
  }
  const modelsRaw = value.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new CatalogError("`models` must be a non-empty array", path);
  }
  const seenIds = new Set<string>();
  const models: CatalogEntry[] = modelsRaw.map((entry, index) => {
    const where = `models[${index}]`;
    if (!isRecord(entry)) {
      throw new CatalogError(`${where} must be an object`, path);
    }
    const id = requireNonEmptyString(entry.id, `${where}.id`, path);
    if (seenIds.has(id)) {
      throw new CatalogError(`${where}.id "${id}" is duplicated`, path);
    }
    seenIds.add(id);

    const specializations = requireEnumArray(
      entry.specializations,
      MODEL_SPECIALIZATION_VALUES,
      `${where}.specializations`,
      path,
    );
    const execution_modes = requireEnumArray(
      entry.execution_modes,
      DOWNSTREAM_EXECUTION_MODE_VALUES,
      `${where}.execution_modes`,
      path,
    );
    const tier = requireEnumValue(
      entry.tier,
      DOWNSTREAM_MODEL_TIER_VALUES,
      `${where}.tier`,
      path,
    );

    const params_in_billions = requirePositiveNumberOrNull(
      entry.params_in_billions,
      `${where}.params_in_billions`,
      path,
    );
    const context_window = requirePositiveInteger(
      entry.context_window,
      `${where}.context_window`,
      path,
    );
    const pricing = requirePricing(entry, where, path);

    ensureAllowedKeysCatalog(
      entry,
      [
        "id",
        "provider",
        "runtime",
        "specializations",
        "execution_modes",
        "tier",
        "params_in_billions",
        "context_window",
        "max_output_tokens",
        "upstream_max_context_window",
        "input_tokens_cpm",
        "cached_tokens_cpm",
        "output_tokens_cpm",
      ],
      where,
      path,
    );

    return {
      id,
      specializations,
      execution_modes,
      tier,
      params_in_billions,
      context_window,
      ...pricing,
    };
  });

  const defaultId = requireNonEmptyString(value.default, "default", path);
  if (!seenIds.has(defaultId)) {
    throw new CatalogError(
      `default "${defaultId}" must reference an existing models[].id`,
      path,
    );
  }

  ensureAllowedKeysCatalog(value, ["models", "default", "pricing_unit", "notes"], "<root>", path);

  return { models, default: defaultId };
}

// ─── Internal validation helpers ────────────────────────────────────────────

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, where: string, path?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError(`${where} must be a non-empty string`, path);
  }
  return value;
}

function requirePositiveInteger(value: unknown, where: string, path?: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new CatalogError(`${where} must be a positive integer`, path);
  }
  return value;
}

function requirePositiveNumber(value: unknown, where: string, path?: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CatalogError(`${where} must be a positive number`, path);
  }
  return value;
}

function requirePositiveNumberOrNull(value: unknown, where: string, path?: string): number | null {
  if (value === null) {
    return null;
  }
  return requirePositiveNumber(value, where, path);
}

function requireNonNegativeNumber(value: unknown, where: string, path?: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CatalogError(`${where} must be a non-negative number`, path);
  }
  return value;
}

function requireEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
  path?: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CatalogError(`${where} must be one of: ${allowed.join(", ")}`, path);
  }
  return value as T;
}

function requireEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
  path?: string,
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CatalogError(`${where} must be a non-empty array`, path);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      throw new CatalogError(
        `${where}[${i}] must be one of: ${allowed.join(", ")}`,
        path,
      );
    }
    if (seen.has(item)) {
      throw new CatalogError(`${where}[${i}] duplicates a prior entry`, path);
    }
    seen.add(item);
    result.push(item as T);
  }
  return result;
}

function requirePricing(
  entry: Record<string, unknown>,
  where: string,
  path?: string,
): Pick<CatalogEntry, "input_tokens_cpm" | "cached_tokens_cpm" | "output_tokens_cpm"> {
  const pricingKeys = ["input_tokens_cpm", "cached_tokens_cpm", "output_tokens_cpm"] as const;
  const present = pricingKeys.filter((key) => key in entry);
  if (present.length === 0) return {};
  if (present.length !== pricingKeys.length) {
    throw new CatalogError(
      `${where} pricing fields must be provided all together or omitted all together`,
      path,
    );
  }
  return {
    input_tokens_cpm: requireNonNegativeNumber(
      entry.input_tokens_cpm,
      `${where}.input_tokens_cpm`,
      path,
    ),
    cached_tokens_cpm: requireNonNegativeNumber(
      entry.cached_tokens_cpm,
      `${where}.cached_tokens_cpm`,
      path,
    ),
    output_tokens_cpm: requireNonNegativeNumber(
      entry.output_tokens_cpm,
      `${where}.output_tokens_cpm`,
      path,
    ),
  };
}

function ensureAllowedKeysCatalog(
  value: Record<string, unknown>,
  keys: readonly string[],
  where: string,
  path?: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new CatalogError(`${where} has unsupported field "${key}"`, path);
    }
  }
}
