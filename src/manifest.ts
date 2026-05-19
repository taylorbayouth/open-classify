import type { RuntimeClassifierManifest } from "./stock.js";
import type { ClassifierInput, ClassifierRunStatus } from "./types.js";
import type { DownstreamModelTier, ModelSpecialization, PromptInjectionRiskLevel } from "./enums.js";

export type ClassifierName = string;
export type ClassifierResults = Record<ClassifierName, import("./stock.js").ClassifierOutput>;

export type RunClassifier = (
  name: ClassifierName,
  input: ClassifierInput,
  signal: AbortSignal,
) => Promise<import("./stock.js").ClassifierOutput>;

export interface CatalogEntry {
  readonly id: string;
  readonly specializations: ReadonlyArray<ModelSpecialization>;
  readonly tier: DownstreamModelTier;
  readonly params_in_billions: number | null;
  readonly context_window: number;
  readonly input_tokens_cpm?: number;
  readonly cached_tokens_cpm?: number;
  readonly output_tokens_cpm?: number;
}

export interface Catalog {
  readonly models: ReadonlyArray<CatalogEntry>;
  readonly default: string;
}

// Public flat map keyed by classifier name. Each entry includes all payload
// fields plus `reason` (string) and `certainty` (float 0–1).
export type ClassifierPublicOutputs = Record<string, Record<string, unknown>>;

export type PipelineAction = "route" | "block" | "reply";
export type BlockReason = "prompt_injection" | "classification_error";

export interface ReplySignal {
  readonly text: string;
}

export interface PipelineResult {
  readonly action: PipelineAction;
  readonly block_reason?: BlockReason;
  readonly target_message_hash: string;
  // Resolved concrete model id. May be null on classification_error blocks.
  readonly model_id: string | null;
  // Tool ids the downstream model should have access to. Always present.
  readonly tools: ReadonlyArray<string>;
  // Preflight reply — present when preflight ran successfully.
  readonly reply: ReplySignal | null;
  // Prompt injection result — present when the classifier ran.
  readonly prompt_injection: { readonly risk_level: PromptInjectionRiskLevel } | null;
  readonly avg_certainty: number;
  readonly min_certainty: number;
  // Float certainty score per classifier (0–1). Same values as classifier_outputs[name].certainty.
  readonly classifier_certainties: Record<string, number>;
  // Names of classifiers that errored or timed out (used their fallback).
  readonly failed_classifiers: ReadonlyArray<string>;
  readonly classifier_outputs: ClassifierPublicOutputs;
}

// Result of inspect() — the lean assistant-output pass. Purely observational:
// no routing, no action. Callers use it for post-hoc transforms and safety
// checks on assistant replies.
export interface InspectResult {
  readonly target_message_hash: string;
  // The raw assistant message that was inspected.
  readonly message: { readonly role: "assistant"; readonly text: string };
  // Float certainty score per classifier (0–1). Same values as classifier_outputs[name].certainty.
  readonly classifier_certainties: Record<string, number>;
  readonly classifier_outputs: ClassifierPublicOutputs;
}

export type ClassifierRegistry = ReadonlyArray<RuntimeClassifierManifest>;
