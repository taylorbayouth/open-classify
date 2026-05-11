// Central registry of every classifier module. The pipeline iterates this
// tuple and has no name-specific knowledge of any classifier — short-circuit
// behavior, downstream-envelope contributions, UI labels, and backend hints
// all live on the module itself.
//
// Adding a new classifier? Three steps:
//   1. Create `src/classifiers/<name>/` with `prompt.ts`, `result.ts`,
//      `module.ts` (mirror an existing module).
//   2. Append the module to `REGISTRY` below.
//   3. If the classifier's outputs are categorical, add the enum(s) to
//      `enums.ts` so validators and the UI server can read them.

import { preflightModule } from "./classifiers/preflight/module.js";
import { routingModule } from "./classifiers/routing/module.js";
import { conversationHistoryModule } from "./classifiers/conversation_history/module.js";
import { memoryRetrievalQueriesModule } from "./classifiers/memory_retrieval_queries/module.js";
import { toolsModule } from "./classifiers/tools/module.js";
import { modelSpecializationModule } from "./classifiers/model_specialization/module.js";
import { securityModule } from "./classifiers/security/module.js";
import type {
  AnyClassifierModule,
  ClassifierNameOf,
  ClassifierResultsMap,
  Registry,
} from "./manifest.js";
import type { ClassifierInput } from "./types.js";

// Tuple order is the canonical classifier order surfaced to UIs and the SSE
// stream. Short-circuit evaluation order is independent — it comes from each
// module's `shortCircuit.priority`.
export const REGISTRY = [
  preflightModule,
  routingModule,
  conversationHistoryModule,
  memoryRetrievalQueriesModule,
  toolsModule,
  modelSpecializationModule,
  securityModule,
] as const satisfies Registry;

export type RegistryType = typeof REGISTRY;
export type ClassifierName = ClassifierNameOf<RegistryType>;

export const CLASSIFIER_NAMES = REGISTRY.map((m) => m.name) as ClassifierName[];

// Convenience lookup: name → module. Useful for backends that need the
// system prompt (Ollama), UI labels, validators, or fallbacks without
// iterating the tuple at every call site.
export const MODULES_BY_NAME = Object.fromEntries(
  REGISTRY.map((m) => [m.name, m as AnyClassifierModule]),
) as Record<ClassifierName, AnyClassifierModule>;

// Concrete map: classifier name → that classifier's typed Result.
export type ClassifierResults = ClassifierResultsMap<RegistryType>;

// The function shape required to plug a custom backend into the pipeline.
// The Ollama runner in `ollama.ts` is one implementation; you can write your
// own (OpenAI, Anthropic, mocks for tests, etc.) as long as it satisfies this.
// The return type is narrowed against the classifier name so callers don't
// need to cast at the call site.
export type RunClassifier = <Name extends ClassifierName>(
  name: Name,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierResults[Name]>;
