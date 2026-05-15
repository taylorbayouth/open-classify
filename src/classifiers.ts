import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassifierInput } from "./types.js";
import type {
  ClassifierName,
  ClassifierRegistry,
  RunClassifier,
} from "./manifest.js";
import type {
  ClassifierOutput,
  RuntimeClassifierManifest,
} from "./stock.js";
import { buildStockClassifierPrompt } from "./stock-prompt.js";
import {
  validateJsonClassifierManifest,
  validateOutputForManifest,
} from "./stock-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLASSIFIERS_DIR = join(__dirname, "classifiers");
const KIND_DIRS = ["stock", "custom"] as const;

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

  const manifests: RuntimeClassifierManifest[] = [];
  for (const kind of KIND_DIRS) {
    const kindDir = join(classifiersDir, kind);
    if (!existsSync(kindDir)) continue;
    for (const entry of readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (kind === "stock" && entry.name === "prompts") continue;
      manifests.push(loadClassifierManifest(join(kindDir, entry.name), kind));
    }
  }
  manifests.sort((a, b) => a.order - b.order);
  validateRegistry(manifests);
  return manifests;
}

function loadClassifierManifest(
  classifierDir: string,
  expectedKind: "stock" | "custom",
): RuntimeClassifierManifest {
  const manifestPath = join(classifierDir, "manifest.json");
  const promptPath = join(classifierDir, "prompt.md");
  if (!existsSync(manifestPath)) {
    throw new ClassifierManifestError(`missing manifest.json in ${classifierDir}`);
  }
  if (expectedKind === "custom" && !existsSync(promptPath)) {
    throw new ClassifierManifestError(`missing prompt.md in ${classifierDir}`);
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const manifest = validateJsonClassifierManifest(parsed, manifestPath);
  if (manifest.kind !== expectedKind) {
    throw new ClassifierManifestError(
      `${manifestPath}: manifest kind "${manifest.kind}" does not match parent directory "${expectedKind}"`,
    );
  }
  const directoryName = basename(classifierDir);
  if (manifest.name !== directoryName) {
    throw new ClassifierManifestError(
      `${manifestPath}: manifest name "${manifest.name}" does not match directory "${directoryName}"`,
    );
  }
  let systemPrompt = buildStockClassifierPrompt(manifest);
  if (manifest.kind === "custom") {
    const classifierPrompt = readFileSync(promptPath, "utf8").trim();
    if (classifierPrompt.length === 0) {
      throw new ClassifierManifestError(`prompt.md must not be empty: ${promptPath}`);
    }
    systemPrompt = `${systemPrompt}\n\nClassifier guidance:\n${classifierPrompt}`;
  }

  return { ...manifest, systemPrompt } as RuntimeClassifierManifest;
}

function validateRegistry(manifests: ReadonlyArray<RuntimeClassifierManifest>): void {
  // Duplicate orders are allowed: same-order classifiers schedule adjacent
  // and run in parallel when concurrency permits, sequentially otherwise.
  const names = new Set<string>();
  for (const manifest of manifests) {
    if (names.has(manifest.name)) {
      throw new ClassifierManifestError(`duplicate classifier name: ${manifest.name}`);
    }
    names.add(manifest.name);
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
): ClassifierOutput {
  const manifest = MODULES_BY_NAME[name];
  if (!manifest) {
    throw new ClassifierManifestError(`unknown classifier: ${name}`);
  }
  return validateOutputForManifest(manifest, value, { classifier: name, model });
}

export type { ClassifierInput };
