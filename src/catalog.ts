// Strict loader and validator for `downstream-models.json` — the authoritative
// source for every downstream model's metadata (id, axis fit, parameter
// count, context window). Classifiers never emit any of these fields; the
// aggregator's model resolver reads them directly from a loaded `Catalog`.
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
import type {
  Catalog,
  CatalogEntry,
  ConcreteDownstreamExecutionMode,
  ConcreteDownstreamModelTier,
  ConcreteModelSpecialization,
} from "./manifest.js";

export class CatalogError extends Error {
  readonly path?: string;
  constructor(message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "CatalogError";
    this.path = path;
  }
}

// Enums minus their escape-hatch values. A catalog entry that advertised
// "unclear" specialization wouldn't be matchable by anything — strip those
// values out at load so the validator rejects them up front.
const CONCRETE_SPECIALIZATIONS = MODEL_SPECIALIZATION_VALUES.filter(
  (value): value is ConcreteModelSpecialization => value !== "unclear",
);
const CONCRETE_EXECUTION_MODES = DOWNSTREAM_EXECUTION_MODE_VALUES.filter(
  (value): value is ConcreteDownstreamExecutionMode =>
    value !== "unable_to_determine",
);
const CONCRETE_TIERS = DOWNSTREAM_MODEL_TIER_VALUES.filter(
  (value): value is ConcreteDownstreamModelTier =>
    value !== "unable_to_determine",
);

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

    const specializations = requireConcreteArray(
      entry.specializations,
      CONCRETE_SPECIALIZATIONS,
      `${where}.specializations`,
      path,
    );
    const execution_modes = requireConcreteArray(
      entry.execution_modes,
      CONCRETE_EXECUTION_MODES,
      `${where}.execution_modes`,
      path,
    );
    const tiers = requireConcreteArray(
      entry.tiers,
      CONCRETE_TIERS,
      `${where}.tiers`,
      path,
    );

    const params_in_millions = requirePositiveInteger(
      entry.params_in_millions,
      `${where}.params_in_millions`,
      path,
    );
    const context_window = requirePositiveInteger(
      entry.context_window,
      `${where}.context_window`,
      path,
    );

    ensureExactKeysCatalog(
      entry,
      ["id", "specializations", "execution_modes", "tiers", "params_in_millions", "context_window"],
      where,
      path,
    );

    return {
      id,
      specializations,
      execution_modes,
      tiers,
      params_in_millions,
      context_window,
    };
  });

  const defaultId = requireNonEmptyString(value.default, "default", path);
  if (!seenIds.has(defaultId)) {
    throw new CatalogError(
      `default "${defaultId}" must reference an existing models[].id`,
      path,
    );
  }

  ensureExactKeysCatalog(value, ["models", "default"], "<root>", path);

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

function requireConcreteArray<T extends string>(
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

function ensureExactKeysCatalog(
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
  for (const key of keys) {
    if (!(key in value)) {
      throw new CatalogError(`${where} is missing required field "${key}"`, path);
    }
  }
}
