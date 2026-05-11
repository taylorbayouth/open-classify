import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassifierInput } from "./types.js";
import type {
  ClassifierName,
  ClassifierRegistry,
  RunClassifier,
} from "./manifest.js";
import type { RuntimeClassifierManifest, StockClassifierOutput } from "./stock.js";
import {
  validateJsonClassifierManifest,
  validateStockClassifierOutput,
} from "./stock-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLASSIFIERS_DIR = join(__dirname, "classifiers");

export class ClassifierManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierManifestError";
  }
}

export function loadClassifierRegistry(
  classifiersDir = CLASSIFIERS_DIR,
): RuntimeClassifierManifest[] {
  if (!existsSync(classifiersDir)) {
    throw new ClassifierManifestError(`classifier directory not found: ${classifiersDir}`);
  }

  const manifests = readdirSync(classifiersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadClassifierManifest(join(classifiersDir, entry.name)))
    .sort((a, b) => a.order - b.order);

  validateRegistry(manifests);
  return manifests;
}

function loadClassifierManifest(classifierDir: string): RuntimeClassifierManifest {
  const manifestPath = join(classifierDir, "manifest.json");
  const promptPath = join(classifierDir, "prompt.md");
  if (!existsSync(manifestPath)) {
    throw new ClassifierManifestError(`missing manifest.json in ${classifierDir}`);
  }
  if (!existsSync(promptPath)) {
    throw new ClassifierManifestError(`missing prompt.md in ${classifierDir}`);
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const manifest = validateJsonClassifierManifest(parsed, manifestPath);
  const systemPrompt = readFileSync(promptPath, "utf8").trim();
  if (systemPrompt.length === 0) {
    throw new ClassifierManifestError(`prompt.md must not be empty: ${promptPath}`);
  }

  return { ...manifest, systemPrompt };
}

function validateRegistry(manifests: ReadonlyArray<RuntimeClassifierManifest>): void {
  const names = new Set<string>();
  const orders = new Set<number>();
  for (const manifest of manifests) {
    if (names.has(manifest.name)) {
      throw new ClassifierManifestError(`duplicate classifier name: ${manifest.name}`);
    }
    names.add(manifest.name);
    if (orders.has(manifest.order)) {
      throw new ClassifierManifestError(`duplicate classifier order: ${manifest.order}`);
    }
    orders.add(manifest.order);
  }
}

export const REGISTRY = loadClassifierRegistry() as ClassifierRegistry;
export const CLASSIFIER_NAMES = REGISTRY.map((m) => m.name);
export const MODULES_BY_NAME = Object.fromEntries(
  REGISTRY.map((m) => [m.name, m]),
) as Record<string, RuntimeClassifierManifest>;

export type { ClassifierName, RunClassifier };
export type RegistryType = typeof REGISTRY;

export function validateClassifierOutput(
  name: string,
  value: unknown,
  model: string,
): StockClassifierOutput {
  const manifest = MODULES_BY_NAME[name];
  if (!manifest) {
    throw new ClassifierManifestError(`unknown classifier: ${name}`);
  }
  return validateStockClassifierOutput(value, {
    classifier: name,
    model,
    emits: manifest.emits,
    toolFamilies: manifest.tool_families?.map((family) => family.id),
    outputSchema: manifest.output_schema,
  });
}

export type { ClassifierInput };
