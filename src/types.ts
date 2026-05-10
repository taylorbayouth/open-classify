// Shared type surface for Open Classify. Most types here are part of the
// public API — they describe inputs callers send, outputs they receive, and
// the contract a custom `RunClassifier` must satisfy.

import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  ModelSpecialization,
  SecurityRiskLevel,
  SecuritySignal,
  ToolFamily,
} from "./enums.js";
import type { PreflightResult } from "./classifiers/preflight/result.js";
import type { RoutingResult } from "./classifiers/routing/result.js";
import type { ConversationHistoryResult } from "./classifiers/conversation_history/result.js";
import type { MemoryRetrievalQueriesResult } from "./classifiers/memory_retrieval_queries/result.js";
import type { ToolsResult } from "./classifiers/tools/result.js";
import type { ModelSpecializationResult } from "./classifiers/model_specialization/result.js";
import type { SecurityResult } from "./classifiers/security/result.js";

export type { PreflightResult } from "./classifiers/preflight/result.js";
export type { RoutingResult } from "./classifiers/routing/result.js";
export type { ConversationHistoryResult } from "./classifiers/conversation_history/result.js";
export type { MemoryRetrievalQueriesResult } from "./classifiers/memory_retrieval_queries/result.js";
export type { ToolsResult } from "./classifiers/tools/result.js";
export type { ModelSpecializationResult } from "./classifiers/model_specialization/result.js";
export type { SecurityResult } from "./classifiers/security/result.js";
export { TERMINALITY_VALUES, type Terminality } from "./classifiers/preflight/result.js";

// "Concrete" variants drop the escape-hatch values (`unable_to_determine`,
// `unclear`). They exist because those fallbacks shouldn't be valid lookup
// keys when resolving a downstream model — you can't have a model named
// `unclear.unable_to_determine`.
export type ConcreteDownstreamModelTier = Exclude<
  DownstreamModelTier,
  "unable_to_determine"
>;
export type ConcreteModelSpecialization = Exclude<ModelSpecialization, "unclear">;

// Lookup keys for `DownstreamModelConfig`. The pipeline tries them in this
// order: most-specific (`coding.local_strong`) → tier alone → specialization
// alone → `default`. See `resolveDownstreamModel` in pipeline.ts.
export type DownstreamModelConfigKey =
  | `${ConcreteModelSpecialization}.${ConcreteDownstreamModelTier}`
  | ConcreteDownstreamModelTier
  | ConcreteModelSpecialization
  | "default";

// Caller-supplied mapping from lookup key → model identifier string. Sparse
// is fine; missing keys just fall through to less-specific entries.
export type DownstreamModelConfig = Partial<Record<DownstreamModelConfigKey, string>>;

export type ConversationMessageRole = "user" | "assistant";

export interface AttachmentInput {
  filename?: string;
  size_bytes?: number;
  mime_type?: string;
}

export interface ConversationMessageInput {
  role?: ConversationMessageRole;
  text: string;
}

export interface OpenClassifyInput {
  /**
   * Chronological message history ending with the message to classify.
   *
   * Callers should send the context they already have. Open Classify classifies
   * only the final message and uses earlier messages as context. Normalization
   * walks backward from the final message, keeps newest whole context messages
   * while the classifier payload budget allows, and caps the retained history to
   * 20 messages. It never slices message text.
   */
  messages: ConversationMessageInput[];
  attachments?: AttachmentInput[];
}

// Result of running the input through `normalizeOpenClassifyInput`. `text` is
// the final message's sanitized text (the thing actually being classified);
// `target_message_hash` is a stable 8-hex-char fingerprint of the target
// message, useful for deduping or correlating results.
export interface NormalizedOpenClassifyInput {
  messages: ConversationMessageInput[];
  text: string;
  attachments: AttachmentInput[];
  target_message_hash: string;
}

// What every classifier sees. Structurally identical to the normalized input —
// kept as its own type so future divergence (e.g. classifier-specific
// projections) doesn't break the public contract.
export interface ClassifierInput {
  text: string;
  messages: ConversationMessageInput[];
  attachments: AttachmentInput[];
  target_message_hash: string;
}

// All per-classifier Result types now live in `src/classifiers/<name>/result.ts`
// and are re-exported above for backwards compatibility with consumers that
// haven't migrated their imports yet. Each one extends ClassifierResultBase
// (reason + confidence).

// Aggregate of every classifier's output. Keys must match `ClassifierName`.
export interface OpenClassifyResult {
  preflight: PreflightResult;
  routing: RoutingResult;
  conversation_history: ConversationHistoryResult;
  memory_retrieval_queries: MemoryRetrievalQueriesResult;
  tools: ToolsResult;
  model_specialization: ModelSpecializationResult;
  security: SecurityResult;
}

// How the pipeline arrived at the chosen downstream model. `key` is the most-
// specific candidate that was tried (always set); `resolved_from` is the key
// that actually had a value in the caller's `downstreamModels` config (may
// equal `key`, or be a less specific fallback, or be null if nothing matched).
// The resolved model identifier itself lives at `OpenClassifyHandoff.model`.
export interface ModelResolution {
  key: DownstreamModelConfigKey;
  resolved_from: DownstreamModelConfigKey | null;
  tier: DownstreamModelTier;
  specialization: ModelSpecialization;
}

// Whether the rolled-up memory queries are trustworthy. "ok" means the
// memory_retrieval_queries classifier ran and produced a verdict (possibly
// empty); "unavailable" means it fell back, so an empty `queries` array is
// the absence of a verdict, not a real "no memory needed" signal.
export type MemoryStatus = "ok" | "unavailable";

// The shape downstream code actually consumes — a flattened, opinionated view
// of the seven classifier outputs. If you only care about "what should the
// assistant do next?", this is the type to lean on.
export interface OpenClassifyHandoff {
  execution_mode: DownstreamExecutionMode;
  // The resolved downstream model identifier, or null when the caller's
  // `downstreamModels` config has no matching entry. This is the irreducible
  // routing answer; `model_resolution` is the breakdown of how it was picked.
  model: string | null;
  model_resolution: ModelResolution;
  context: {
    conversation: {
      // Length of this array IS the prior-messages count — the runner sliced
      // the right suffix for you. There's no separate count field.
      messages: ConversationMessageInput[];
      needs_unseen_history: boolean;
    };
    memory: {
      queries: string[];
      status: MemoryStatus;
    };
    tools: {
      // Kept distinct from `families.length > 0`: the model can flag "yes
      // tools needed" without picking a specific family.
      needed: boolean;
      families: ToolFamily[];
    };
  };
  safety: {
    risk_level: SecurityRiskLevel;
    signals: SecuritySignal[];
  };
}

export type ClassifierName = keyof OpenClassifyResult;

export type ClassifierOutput<Name extends ClassifierName> = OpenClassifyResult[Name];

// The function shape required to plug a custom backend into the pipeline. The
// Ollama runner in `ollama.ts` is one implementation; you can write your own
// (OpenAI, Anthropic, mocks for tests, etc.) as long as it satisfies this.
export type RunClassifier = <Name extends ClassifierName>(
  name: Name,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<ClassifierOutput<Name>>;

// Why a classifier fell back to its default output instead of a model answer.
export type ClassifierFallbackReason = "error" | "timeout";

// Per-classifier execution metadata. Lives inside the merged classifier entry
// so callers see the verdict and the operational state in one place.
export interface ClassifierRunStatus {
  ok: boolean;
  source: "model" | "fallback";
  reason?: ClassifierFallbackReason;
  error?: string;
}

// One per classifier: the verdict fields plus an embedded `status`. When
// `status.ok` is false, the verdict fields are the conservative fallback
// defaults and verdict-level `reason` is empty — read `status.error` for the
// operational explanation.
export type ClassifierEntry<Name extends ClassifierName> = ClassifierOutput<Name> & {
  status: ClassifierRunStatus;
};

// All seven classifiers ran (or fell back) and produced an entry. Used on the
// route path.
export type FullClassifierEntries = {
  [Name in ClassifierName]: ClassifierEntry<Name>;
};

// Subset of classifiers ran. Used on terminal (preflight only) and block
// (preflight + security) paths — the other classifiers were aborted before
// they could finish, so they don't appear at all.
export type PartialClassifierEntries = Partial<{
  [Name in ClassifierName]: ClassifierEntry<Name>;
}>;

// Observability surface. Lives under `meta` on every pipeline result so the
// top-level (decision, reply, target_message_hash, handoff?) can stay lean.
export interface OpenClassifyMeta<Entries extends PartialClassifierEntries = PartialClassifierEntries> {
  classifiers: Entries;
}

// Pipeline returns one of three shapes, discriminated by `decision`. Narrow
// on `decision` before reaching for shape-specific fields (e.g. `handoff` is
// only present on the route variant).

// Preflight said the assistant can stop now and reply with `reply` directly.
// No other classifiers ran (they were aborted to save compute), so
// `meta.classifiers` contains only `preflight`.
export interface OpenClassifyTerminalPipelineResult {
  decision: "terminal";
  target_message_hash: string;
  reply: string;
  meta: OpenClassifyMeta<{ preflight: ClassifierEntry<"preflight"> }>;
}

// Security flagged the message as high-risk. Pipeline aborts the rest and
// returns no reply — callers who want a refusal should detect
// `decision === "block"` and craft their own copy. `meta.classifiers`
// contains only `security` (the classifier whose verdict drove the block).
export interface OpenClassifyBlockPipelineResult {
  decision: "block";
  target_message_hash: string;
  meta: OpenClassifyMeta<{
    security: ClassifierEntry<"security">;
  }>;
}

// Normal path: route the message to the downstream assistant. All seven
// classifiers ran (or fell back), and `handoff` summarizes their decisions
// for downstream consumption.
export interface OpenClassifyRoutePipelineResult {
  decision: "route";
  target_message_hash: string;
  reply: string;
  handoff: OpenClassifyHandoff;
  meta: OpenClassifyMeta<FullClassifierEntries>;
}

export type OpenClassifyPipelineResult =
  | OpenClassifyTerminalPipelineResult
  | OpenClassifyBlockPipelineResult
  | OpenClassifyRoutePipelineResult;
