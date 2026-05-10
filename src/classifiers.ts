// Central registry of every classifier. The pipeline iterates the REGISTRY
// tuple directly — no name-specific knowledge anywhere in pipeline.ts. To add
// a new classifier:
//   1. Create src/classifiers/<name>/{prompt,result,fixtures,module}.ts
//   2. Import the module here and slot it into REGISTRY below
//   3. The type system will surface any consumer that needs updating
//
// The CLASSIFIERS keyed map and CLASSIFIER_NAMES array are derived from the
// registry tuple — they exist for backwards compatibility with callers that
// look modules up by name (the UI server, the Ollama runner, fixtures).

import type {
  AnyClassifierModule,
  ClassifierModule,
  ClassifierResultBase,
} from "./manifest.js";
import type { ClassifierName } from "./types.js";
import { preflightModule } from "./classifiers/preflight/module.js";
import { routingModule } from "./classifiers/routing/module.js";
import { conversationHistoryModule } from "./classifiers/conversation_history/module.js";
import { memoryRetrievalQueriesModule } from "./classifiers/memory_retrieval_queries/module.js";
import { toolsModule } from "./classifiers/tools/module.js";
import { modelSpecializationModule } from "./classifiers/model_specialization/module.js";
import { securityModule } from "./classifiers/security/module.js";

export const REGISTRY = [
  preflightModule,
  routingModule,
  conversationHistoryModule,
  memoryRetrievalQueriesModule,
  toolsModule,
  modelSpecializationModule,
  securityModule,
] as const;

export type Registry = typeof REGISTRY;

// `ClassifierName` is still re-exported from types.js for now (structurally
// equivalent to Registry[number]["name"]). Once types.ts is slimmed, this
// will become the source of truth.

// Derived map keyed by literal name. Built once from REGISTRY so the order
// of names is exactly the registry order.
type ClassifiersMap = {
  [M in Registry[number] as M["name"]]: M;
};

export const CLASSIFIERS: ClassifiersMap = Object.fromEntries(
  REGISTRY.map((module_) => [module_.name, module_]),
) as ClassifiersMap;

export const CLASSIFIER_NAMES = REGISTRY.map(
  (module_) => module_.name,
) as ClassifierName[];

// Runtime lookup helper. Returns the classifier-specific module typed against
// the literal name; useful in callsites that take a generic `Name` and want
// to read the matching module's purpose/systemPrompt/etc.
export function getModule<N extends ClassifierName>(name: N): ClassifiersMap[N] {
  return CLASSIFIERS[name];
}

// Type-erased registry iteration for callers that handle every module
// uniformly. Use `REGISTRY` directly when you want literal-typed entries.
// `unknown` cast is needed because each module's Result type is contravariant
// in shortCircuit/contributions; the runtime contract is identical.
export const ALL_MODULES: ReadonlyArray<AnyClassifierModule> =
  REGISTRY as unknown as ReadonlyArray<AnyClassifierModule>;

// Re-export for callers that previously imported the manifest contract
// through this file.
export type { ClassifierModule, ClassifierResultBase };
