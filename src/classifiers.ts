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
export const BUILTIN_CLASSIFIERS_DIR = join(__dirname, "classifiers");
export const STOCK_CLASSIFIER_NAMES = [
  "tools",
  "memory_retrieval_queries",
  "conversation_digest",
  "context_shift",
] as const;

export type StockClassifierName = (typeof STOCK_CLASSIFIER_NAMES)[number];

export const STOCK_CLASSIFIERS_DIR = findStockClassifiersDir();

function findStockClassifiersDir(): string {
  // Source runs use ../templates; built package runs use ../../templates from
  // dist/src. Keep both so tests and the published package agree.
  const candidates = [
    join(__dirname, "..", "templates"),
    join(__dirname, "..", "..", "templates"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

// Directories whose names start with "_" are reserved for shared assets
// (e.g. `_prompts/`) and are not loaded as classifiers. Consumers can use
// the same convention in their own classifier directories: rename a
// classifier to `_<name>/` to deactivate it without deleting it.
const SHARED_DIRECTORY_PREFIX = "_";

export class ClassifierManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierManifestError";
  }
}

export type ClassifierModuleMap = Readonly<Record<string, RuntimeClassifierManifest>>;

export interface ClassifierRegistryBundle {
  readonly registry: ClassifierRegistry;
  readonly modulesByName: ClassifierModuleMap;
  readonly names: ReadonlyArray<string>;
}

export interface BuildRegistryOptions {
  // Optional package-owned stock classifiers to load in addition to mandatory
  // built-ins. These live in the package so `npm update open-classify` can
  // improve their prompts without touching consumer projects.
  readonly stockClassifierNames?: ReadonlyArray<string>;

  // Additional classifier directories to merge with the bundled built-ins.
  // Each entry is scanned the same way as the built-in directory: each
  // child folder must contain `manifest.json` + `prompt.md`. Folders whose
  // names start with `_` are skipped — that's the deactivation mechanism.
  readonly extraDirs?: ReadonlyArray<string>;
}

// Load all classifier manifests under a single directory. Used internally to
// load the built-ins and each extra directory; callers wanting the merged
// registry should use `buildClassifierRegistry()` instead.
export function loadClassifierRegistry(
  classifiersDir: string = BUILTIN_CLASSIFIERS_DIR,
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
  return manifests;
}

// Build a complete classifier registry from the bundled built-ins plus any
// extra directories supplied by the caller. Sorts by dispatch_order
// ascending (manifests without dispatch_order sort last). Rejects duplicate
// names.
//
// Mandatory built-ins (preflight, model_tier, model_specialization,
// prompt_injection) always load. Extras with the same name as a built-in
// throw — there's no override mechanism. Customise by editing the bundled
// manifest in your own fork, or replace behaviour entirely with a custom
// `runClassifier`.
export function buildClassifierRegistry(
  options: BuildRegistryOptions = {},
): ClassifierRegistryBundle {
  const manifests = [
    ...loadClassifierRegistry(BUILTIN_CLASSIFIERS_DIR),
    ...(options.stockClassifierNames ?? []).map((name) => loadStockClassifier(name)),
    ...(options.extraDirs ?? []).flatMap((dir) => loadClassifierRegistry(dir)),
  ];
  manifests.sort((a, b) => (a.dispatch_order ?? Infinity) - (b.dispatch_order ?? Infinity));

  validateRegistry(manifests);

  const registry = manifests as ClassifierRegistry;
  const modulesByName = Object.fromEntries(
    manifests.map((m) => [m.name, m]),
  ) as ClassifierModuleMap;
  const names = manifests.map((m) => m.name);

  return { registry, modulesByName, names };
}

function loadStockClassifier(name: string): RuntimeClassifierManifest {
  if (!(STOCK_CLASSIFIER_NAMES as readonly string[]).includes(name)) {
    throw new ClassifierManifestError(
      `unknown stock classifier: ${name} (available: ${STOCK_CLASSIFIER_NAMES.join(", ")})`,
    );
  }
  return loadClassifierManifest(join(STOCK_CLASSIFIERS_DIR, name));
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
      throw new ClassifierManifestError(
        `duplicate classifier name: ${manifest.name} — extras cannot override built-ins or other extras. Rename your classifier or run it under a different name.`,
      );
    }
    names.add(manifest.name);
  }
}

export function validateClassifierOutput(
  manifest: RuntimeClassifierManifest,
  value: unknown,
  model: string,
): ClassifierOutput {
  return validateOutputForManifest(manifest, value, { classifier: manifest.name, model });
}

export type { ClassifierName, RunClassifier };
export type { ClassifierInput };
