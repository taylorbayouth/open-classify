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
import { buildClassifierPrompt } from "./stock-prompt.js";
import {
  validateJsonClassifierManifest,
  validateOutputForManifest,
} from "./stock-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLASSIFIERS_DIR = join(__dirname, "classifiers");
// Directories whose names start with "_" are reserved for shared assets
// (e.g. `_prompts/`) and are not loaded as classifiers.
const SHARED_DIRECTORY_PREFIX = "_";

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
  for (const entry of readdirSync(classifiersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(SHARED_DIRECTORY_PREFIX)) continue;
    manifests.push(loadClassifierManifest(join(classifiersDir, entry.name)));
  }
  // Lower dispatch_order runs first. Classifiers without dispatch_order sort
  // last (treated as +Infinity) — useful for "run me whenever there's a slot".
  manifests.sort((a, b) => (a.dispatch_order ?? Infinity) - (b.dispatch_order ?? Infinity));
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
  const { manifest, reservedFields, composedOutputSchema, appliesTo } =
    validateJsonClassifierManifest(parsed, manifestPath);

  const directoryName = basename(classifierDir);
  if (manifest.name !== directoryName) {
    throw new ClassifierManifestError(
      `${manifestPath}: manifest name "${manifest.name}" does not match directory "${directoryName}"`,
    );
  }

  const classifierPromptText = readFileSync(promptPath, "utf8");
  if (classifierPromptText.trim().length === 0) {
    throw new ClassifierManifestError(`prompt.md must not be empty: ${promptPath}`);
  }

  const systemPrompt = buildClassifierPrompt({
    manifest,
    reservedFields,
    appliesTo,
    classifierPromptText,
  });

  return {
    ...manifest,
    systemPrompt,
    composedOutputSchema,
    reservedFields,
    appliesTo,
  };
}

function validateRegistry(manifests: ReadonlyArray<RuntimeClassifierManifest>): void {
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
