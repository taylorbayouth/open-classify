// Central registry of every classifier. With the module migration, each
// classifier owns its own purpose + systemPrompt (in its module manifest);
// the entry here just reads from that manifest. To add a new classifier:
//   1. Create src/classifiers/<name>/{prompt,result,fixtures,module}.ts
//   2. Import the module here and slot it into CLASSIFIERS below
//   3. If the classifier short-circuits or affects the handoff, the pipeline
//      and aggregator will pick that up automatically from the manifest

import type { ClassifierName } from "./types.js";
import { preflightModule } from "./classifiers/preflight/module.js";
import { routingModule } from "./classifiers/routing/module.js";
import { conversationHistoryModule } from "./classifiers/conversation_history/module.js";
import { memoryRetrievalQueriesModule } from "./classifiers/memory_retrieval_queries/module.js";
import { toolsModule } from "./classifiers/tools/module.js";
import { modelSpecializationModule } from "./classifiers/model_specialization/module.js";
import { securityModule } from "./classifiers/security/module.js";

export interface ClassifierDefinition {
  name: ClassifierName;
  purpose: string;
  systemPrompt: string;
}

export const CLASSIFIERS = {
  preflight: {
    name: preflightModule.name,
    purpose: preflightModule.purpose,
    systemPrompt: preflightModule.systemPrompt,
  },
  routing: {
    name: routingModule.name,
    purpose: routingModule.purpose,
    systemPrompt: routingModule.systemPrompt,
  },
  conversation_history: {
    name: conversationHistoryModule.name,
    purpose: conversationHistoryModule.purpose,
    systemPrompt: conversationHistoryModule.systemPrompt,
  },
  memory_retrieval_queries: {
    name: memoryRetrievalQueriesModule.name,
    purpose: memoryRetrievalQueriesModule.purpose,
    systemPrompt: memoryRetrievalQueriesModule.systemPrompt,
  },
  tools: {
    name: toolsModule.name,
    purpose: toolsModule.purpose,
    systemPrompt: toolsModule.systemPrompt,
  },
  model_specialization: {
    name: modelSpecializationModule.name,
    purpose: modelSpecializationModule.purpose,
    systemPrompt: modelSpecializationModule.systemPrompt,
  },
  security: {
    name: securityModule.name,
    purpose: securityModule.purpose,
    systemPrompt: securityModule.systemPrompt,
  },
} as const satisfies Record<ClassifierName, ClassifierDefinition>;

export const CLASSIFIER_NAMES = Object.keys(CLASSIFIERS) as ClassifierName[];
