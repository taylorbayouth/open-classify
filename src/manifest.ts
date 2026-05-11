// Manifest contract for the modular classifier framework.
//
// This file is the new heart of Open Classify. Every classifier exports a
// `ClassifierModule` matching the shape declared here. The pipeline iterates
// a `Registry` (tuple of modules) and has no name-specific knowledge of any
// classifier — short-circuit behavior, downstream-envelope contributions, UI
// labels, and backend hints all live on the module itself.
//
// Nothing else in the codebase references this file yet. Migrating each
// existing classifier and the pipeline to use these types happens in the
// follow-up steps of the refactor plan.

import type {
  ClassifierInput,
  ClassifierRunStatus,
  ConversationMessageInput,
} from "./types.js";
import type {
  DownstreamExecutionMode,
  DownstreamModelTier,
  ModelSpecialization,
  SecurityRiskLevel,
  SecuritySignal,
} from "./enums.js";

// "Concrete" variants drop the escape-hatch values (`unable_to_determine`,
// `unclear`). They exist because those fallbacks can't be valid catalog
// constraints — you can't have a model that advertises "unclear" as a
// specialization fit.
export type ConcreteDownstreamModelTier = Exclude<
  DownstreamModelTier,
  "unable_to_determine"
>;
export type ConcreteModelSpecialization = Exclude<ModelSpecialization, "unclear">;

// ─── Base contract every classifier output satisfies ────────────────────────

// Required on every classifier Result. Per-module validators enforce the
// shape (e.g. `reason.length <= 200`, `0 <= confidence <= 1`). Convention:
// 0.5 = "default behavior, no strong signal"; 0.9+ should be rare. Fallback
// outputs (when a classifier errors or times out) MUST emit `confidence: 0`
// so they auto-drop from every threshold-gated decision in the aggregator.
export interface ClassifierResultBase {
  reason: string;
  confidence: number;
}

// ─── Short-circuit (replaces hardcoded preflight/security branches) ─────────

export type ShortCircuitKind = "final" | "block" | "clarify";

// Verdict returned by a module's `shortCircuit.evaluate`. `reply` is required
// for `final` and `clarify` (those need text to show the user) and absent
// for `block` (the caller crafts its own refusal copy).
export type ShortCircuitVerdict =
  | { readonly kind: "final"; readonly reply: string }
  | { readonly kind: "clarify"; readonly reply: string }
  | { readonly kind: "block" };

export interface ShortCircuit<Result extends ClassifierResultBase> {
  // Lower priority runs first. Preflight = 0, security = 10 by convention.
  readonly priority: number;
  // Pure predicate over the parsed result. Returning a verdict halts the
  // pipeline and aborts the rest of the in-flight classifiers.
  readonly evaluate: (result: Result) => ShortCircuitVerdict | null;
}

// ─── Concrete execution-mode helper (mirrors the two in types.ts) ───────────
// Excludes the `unable_to_determine` escape hatch so it can't appear as a
// catalog constraint.
export type ConcreteDownstreamExecutionMode = Exclude<
  DownstreamExecutionMode,
  "unable_to_determine"
>;

// ─── Envelope slots — the optional downstream-output fields ─────────────────
// Every module can contribute to any of these via its `contributions` array.
// The aggregator merges all contributions per slot using a declared merge
// rule (overridable per slot by the caller).
export interface EnvelopeSlots {
  // The trimmed message tail downstream should see. Aggregator unions across
  // contributors (superset wins).
  relevant_conversation_history: ConversationMessageInput[];
  // "I gave you what I think is relevant, but I'm not sure I saw everything."
  // OR across contributors.
  requires_full_message_history: boolean;
  // Search strings for RAG / saved-memory lookup. Concat + dedupe.
  memory_queries: string[];
  // Caller-defined tool family names (the caller maps family → tool ids in
  // their own registry). Union across contributors.
  tool_families: string[];
  // Safety verdict surfaced for downstream UX. Highest risk_level wins;
  // signals union.
  safety_signals: { risk_level: SecurityRiskLevel; signals: SecuritySignal[] };
  // Reply text. `final` = downstream isn't called; `ack` = interim placeholder
  // shown while downstream works; `clarify` = ambiguous request needing user
  // input first. Highest-priority contributor wins; tiebreak on confidence.
  quick_reply: {
    text: string;
    kind: "final" | "ack" | "clarify";
    show_after_ms?: number;
  };
  // Drives downstream `max_tokens`. Highest-priority contributor wins.
  expected_response_length: "short" | "medium" | "long";
  // Lets the UI/downstream render correctly. Highest-priority wins.
  output_format_hint: "markdown" | "plain" | "json" | "code";
  // BCP-47 detected user language. Highest-priority wins.
  language: string;
  // Detected PII for downstream redaction. OR `present`; union `categories`.
  pii: { present: boolean; categories: string[] };
  // Per-attachment keep/drop decisions. Union by hash; keep wins on conflict.
  attachment_relevance: Array<{ hash: string; keep: boolean; reason?: string }>;
}

// Per-slot contribution. Discriminated union over `slot`: the type system
// enforces that `build` returns the value type matching the declared slot.
export type Contribution<Result extends ClassifierResultBase> = {
  [S in keyof EnvelopeSlots]: {
    readonly slot: S;
    // Lower runs first when multiple modules contribute to the same slot.
    readonly priority: number;
    readonly build: (
      result: Result,
      ctx: ContributionContext,
    ) => EnvelopeSlots[S] | undefined;
  };
}[keyof EnvelopeSlots];

// Passed to every `Contribution.build`. `results` lets a contributor read
// other classifiers' outputs (e.g. for cross-classifier composition); keyed
// by classifier name with read-only base shape.
export interface ContributionContext {
  readonly results: Readonly<Record<string, ClassifierResultBase>>;
  readonly input: ClassifierInput;
}

// ─── Model recommendation (always present on route) ─────────────────────────

// Caller-provided model catalog (`downstream-models.json`). Each entry
// advertises set membership on three axes (a model can fit multiple
// specializations / execution modes / tiers). `params_in_millions` and
// `context_window` are hand-authored — classifiers never emit either.
export interface CatalogEntry {
  readonly id: string;
  readonly specializations: ReadonlyArray<ConcreteModelSpecialization>;
  readonly execution_modes: ReadonlyArray<ConcreteDownstreamExecutionMode>;
  readonly tiers: ReadonlyArray<ConcreteDownstreamModelTier>;
  readonly params_in_millions: number;
  readonly context_window: number;
}

export interface Catalog {
  readonly models: ReadonlyArray<CatalogEntry>;
  // Must reference an existing `models[].id`. Used when zero confident
  // signals survive or no entry matches the surviving constraints.
  readonly default: string;
}

// Resolver audit trail. Lets callers/UI explain WHY a particular model was
// picked, without re-running the resolver.
export interface ModelRecommendationResolution {
  readonly constraints_used: Partial<{
    specialization: ConcreteModelSpecialization;
    execution_mode: ConcreteDownstreamExecutionMode;
    tier: ConcreteDownstreamModelTier;
  }>;
  readonly constraints_dropped: ReadonlyArray<{
    readonly axis: "specialization" | "execution_mode" | "tier";
    readonly reason: "low_confidence" | "escape_hatch";
  }>;
  readonly confidences: Partial<{
    model_specialization: number;
    routing: number;
  }>;
  readonly fell_back_to_default: boolean;
}

export interface ModelRecommendation {
  readonly id: string;
  readonly params_in_millions: number;
  readonly context_window: number;
  readonly resolution: ModelRecommendationResolution;
}

// ─── Envelope (the route-variant payload) ───────────────────────────────────

// All slot fields are optional — only present if at least one module
// contributed to them. `model_recommendation` is the exception: the catalog
// `default` guarantees it's always populated on a route.
export interface Envelope extends Partial<EnvelopeSlots> {
  readonly model_recommendation: ModelRecommendation;
}

// ─── Aggregator merge overrides ─────────────────────────────────────────────
// Each slot has a default merge rule (see EnvelopeSlots comments). The
// caller can override any of them via pipeline config.

export interface ContributionRef<S extends keyof EnvelopeSlots> {
  readonly source: string; // classifier name
  readonly priority: number;
  readonly confidence: number;
  readonly value: EnvelopeSlots[S];
}

export type MergeFn<S extends keyof EnvelopeSlots> = (
  contributions: ReadonlyArray<ContributionRef<S>>,
) => EnvelopeSlots[S] | undefined;

export type MergeOverrides = Partial<{
  [S in keyof EnvelopeSlots]: MergeFn<S>;
}>;

// ─── Module manifest ────────────────────────────────────────────────────────

// Context passed to a module's hand-rolled validator. `name` and `model` are
// surfaced for error messages (so the existing `OllamaClassifierError`-style
// helpers can be reused after extraction). `input` lets validators slice the
// conversation tail (today's conversation_history pattern).
export interface ClassifierValidationContext {
  readonly name: string;
  readonly model: string;
  readonly input: ClassifierInput;
}

// UI descriptor — the UI server reads these from each module instead of
// hardcoding labels in `ui/app.js`.
export type ClassifierUiRenderer = "enum" | "list" | "boolean" | "object";

export interface ClassifierUiDescriptor {
  readonly label: string;
  readonly optionEnum?: ReadonlyArray<string>;
  readonly renderer?: ClassifierUiRenderer;
}

// Backend hints. Today only Ollama is supported; structure leaves room for
// future backends (OpenAI, Anthropic, etc.) without churning every module.
export interface ClassifierBackends {
  readonly ollama?: {
    readonly baseModel: string;
    readonly adapterModel?: string;
  };
}

// The one shape the pipeline knows. `Name` is a literal so the registry can
// build keyed types; `Result` extends `ClassifierResultBase` so every output
// carries `reason` and `confidence`.
export interface ClassifierModule<
  Name extends string,
  Result extends ClassifierResultBase,
> {
  readonly name: Name;
  // Semver. Surfaced on `meta.classifiers[name].version` so consumers and
  // caches can detect schema/prompt changes without re-deriving them.
  readonly version: string;
  // Human-readable doc — nothing reads it at runtime.
  readonly purpose: string;
  readonly systemPrompt: string;
  // Hand-rolled validator. Returns the typed result or throws. Module
  // authors compose validators out of the shared helpers in src/validation.ts
  // (extracted in a follow-up step).
  readonly validate: (
    value: Record<string, unknown>,
    ctx: ClassifierValidationContext,
  ) => Result;
  // Conservative default returned when the model errors or times out. MUST
  // have `confidence: 0` so the aggregator drops it from threshold-gated
  // decisions automatically.
  readonly fallback: Result;
  readonly shortCircuit?: ShortCircuit<Result>;
  readonly contributions?: ReadonlyArray<Contribution<Result>>;
  readonly backends?: ClassifierBackends;
  readonly ui?: ClassifierUiDescriptor;
}

// ─── Registry + derived types ───────────────────────────────────────────────

// Loosely-typed alias for cases where the specific Name/Result are erased
// (e.g. iterating the registry without narrowing). We use `any` for the
// `Result` parameter so the variance dance doesn't reject specific modules:
// `Result` appears in input position (`validate`, `shortCircuit.evaluate`,
// `contributions[*].build`), which makes `ClassifierModule` invariant in
// `Result` — `ClassifierModule<string, PreflightResult>` is not assignable
// to `ClassifierModule<string, ClassifierResultBase>` even though every
// PreflightResult IS a ClassifierResultBase. `any` is bivariant, which
// papers over the variance issue cleanly. Runtime safety is unaffected
// because the per-module validators still enforce the precise result shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyClassifierModule = ClassifierModule<string, any>;

// Registry is a hand-maintained tuple. Hand-maintained because TypeScript
// needs literal references for the mapped types below to work — filesystem
// auto-discovery would force `any` and lose every guarantee.
export type Registry = ReadonlyArray<AnyClassifierModule>;

export type ModuleOf<R extends Registry, N extends string> = Extract<
  R[number],
  { name: N }
>;

export type ClassifierNameOf<R extends Registry> = R[number]["name"];

export type ResultOf<M> = M extends ClassifierModule<string, infer R>
  ? R
  : never;

// Map of every classifier's typed result, keyed by literal name. Adding a
// module to the registry extends this automatically; removing one breaks
// every consumer at compile time.
export type ClassifierResultsMap<R extends Registry> = {
  [M in R[number] as M["name"]]: ResultOf<M>;
};

// Per-classifier entry in `meta.classifiers`: the typed result plus the
// execution status and the module's version stamp.
export type ClassifierEntryOf<M extends AnyClassifierModule> = ResultOf<M> & {
  readonly status: ClassifierRunStatus;
  readonly version: string;
};

export type FullClassifierEntriesOf<R extends Registry> = {
  [M in R[number] as M["name"]]: ClassifierEntryOf<M>;
};

export type PartialClassifierEntriesOf<R extends Registry> = Partial<
  FullClassifierEntriesOf<R>
>;

// ─── Pipeline result (two variants, registry-derived) ───────────────────────

// Common metadata block.
export interface PipelineMeta<R extends Registry> {
  readonly classifiers: PartialClassifierEntriesOf<R>;
}

export interface PipelineMetaFull<R extends Registry> {
  readonly classifiers: FullClassifierEntriesOf<R>;
}

// Variant 1: any classifier with `shortCircuit` returned a verdict. `fired_by`
// identifies which one (typed against the registry); `kind` discriminates
// "final" / "block" / "clarify". `reply` is present on final and clarify,
// absent on block.
export type ShortCircuitPipelineResult<R extends Registry> = {
  readonly decision: "short_circuit";
  readonly target_message_hash: string;
  readonly fired_by: ClassifierNameOf<R>;
  readonly meta: PipelineMeta<R>;
} & (
  | { readonly kind: "final"; readonly reply: string }
  | { readonly kind: "clarify"; readonly reply: string }
  | { readonly kind: "block" }
);

// Variant 2: normal path. All classifiers ran (or fell back); the envelope
// slot fields are flattened onto the top level alongside `model_recommendation`.
export type RoutePipelineResult<R extends Registry> = {
  readonly decision: "route";
  readonly target_message_hash: string;
  readonly meta: PipelineMetaFull<R>;
} & Envelope;

export type PipelineResult<R extends Registry> =
  | ShortCircuitPipelineResult<R>
  | RoutePipelineResult<R>;

// ─── Aggregator config ──────────────────────────────────────────────────────

// Pipeline-config knobs related to envelope assembly. Plumbed through to
// `composeEnvelope` (src/aggregator.ts).
export interface AggregatorConfig {
  // Below this, a classifier's signal is treated as "no signal" for
  // threshold-gated decisions (currently: model resolver). Default 0.6.
  readonly confidenceThreshold?: number;
  readonly mergeOverrides?: MergeOverrides;
}
