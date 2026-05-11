// Pure envelope composer for the route variant of the pipeline.
//
// Given the registry, the per-classifier results, the model catalog, the
// original input, and optional caller config, this function:
//
//   1. Walks every registered module's `contributions` and bucketizes them
//      per envelope slot.
//   2. Applies the slot's merge rule (default or caller-overridden) to
//      collapse each bucket into a single value.
//   3. Runs the confidence-gated model resolver against the catalog to
//      produce `model_recommendation` (always present).
//
// Pure: same `(registry, results, catalog, input, config)` → same envelope.
// No I/O, no time, no random. Determinism is intentional — it makes evals
// reproducible and lets callers replay "what would the aggregator have done?"
// for free.

import type {
  AggregatorConfig,
  AnyClassifierModule,
  Catalog,
  CatalogEntry,
  ClassifierResultBase,
  ClassifierResultsMap,
  ConcreteDownstreamExecutionMode,
  ConcreteDownstreamModelTier,
  ConcreteModelSpecialization,
  Contribution,
  ContributionContext,
  ContributionRef,
  Envelope,
  EnvelopeSlots,
  MergeFn,
  ModelRecommendation,
  ModelRecommendationResolution,
  Registry,
} from "./manifest.js";
import type {
  ContextSignal,
  RoutingSignal as StockRoutingSignal,
  SafetySignal,
  ToolsSignal,
} from "./stock.js";
import type { ClassifierInput } from "./types.js";
import type { SecurityRiskLevel } from "./enums.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

// Convention: classifiers feeding the model resolver are named
// `model_specialization` and `routing`. The aggregator looks for these names
// in the results map and reads their typed fields. If either isn't in the
// registry, the resolver falls back gracefully (fewer constraints → cheapest
// adequate model in the catalog, or `default` if no hard-capability match).
const MODEL_SPECIALIZATION_NAME = "model_specialization";
const ROUTING_NAME = "routing";

// Shape we need from `model_specialization` for the resolver. Kept local so
// the aggregator doesn't depend on the per-classifier Result type — that
// would couple it to a specific classifier identity.
interface ModelSpecializationSignal extends ClassifierResultBase {
  model_specialization: ConcreteModelSpecialization | "unclear";
}

interface RoutingSignal extends ClassifierResultBase {
  execution_mode: ConcreteDownstreamExecutionMode | "unable_to_determine";
  model_tier: ConcreteDownstreamModelTier | "unable_to_determine";
}

interface ConversationHistorySignal extends ClassifierResultBase {
  is_standalone: boolean;
  refers_to_history: boolean;
  prior_messages_needed: number;
  requires_full_message_history: boolean;
}

interface ToolsClassifierSignal extends ClassifierResultBase {
  needed: boolean;
  families: string[];
}

interface SecurityClassifierSignal extends ClassifierResultBase {
  risk_level: "normal" | "suspicious" | "high_risk" | "unable_to_determine";
  signals: string[];
}

// ─── Public entry point ─────────────────────────────────────────────────────

export interface ComposeEnvelopeArgs<R extends Registry> {
  readonly registry: R;
  readonly results: ClassifierResultsMap<R>;
  readonly catalog: Catalog;
  readonly input: ClassifierInput;
  readonly config?: AggregatorConfig;
}

export function composeEnvelope<R extends Registry>(
  args: ComposeEnvelopeArgs<R>,
): Envelope {
  const { registry, results, catalog, input, config } = args;
  const threshold = config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  // Read-only view of results keyed by classifier name. Contributions get
  // this so they can read sibling classifiers' results when composing.
  const resultsRecord = results as Readonly<Record<string, ClassifierResultBase>>;
  const ctx: ContributionContext = { results: resultsRecord, input };

  const buckets = collectContributions(registry, resultsRecord, ctx);
  const slotValues = applyMerges(buckets, config?.mergeOverrides);

  const model_recommendation = resolveModel(resultsRecord, catalog, threshold);
  const stockSignals = composeStockSignals(resultsRecord, threshold);

  return { ...slotValues, ...stockSignals, model_recommendation };
}

// ─── Collection: walk every module's contributions and bucketize ────────────

type ContributionBuckets = {
  [S in keyof EnvelopeSlots]?: ContributionRef<S>[];
};

function collectContributions<R extends Registry>(
  registry: R,
  results: Readonly<Record<string, ClassifierResultBase>>,
  ctx: ContributionContext,
): ContributionBuckets {
  const buckets: ContributionBuckets = {};

  for (const module_ of registry as ReadonlyArray<AnyClassifierModule>) {
    const result = results[module_.name];
    if (!result) continue;
    if (!module_.contributions) continue;
    for (const contribution of module_.contributions as ReadonlyArray<
      Contribution<ClassifierResultBase>
    >) {
      const value = contribution.build(result, ctx);
      if (value === undefined) continue;
      pushContribution(buckets, contribution.slot, {
        source: module_.name,
        priority: contribution.priority,
        confidence: result.confidence,
        value,
      });
    }
  }

  return buckets;
}

// Single typed insertion point — the cast is isolated to one helper instead
// of being sprinkled at every push site.
function pushContribution<S extends keyof EnvelopeSlots>(
  buckets: ContributionBuckets,
  slot: S,
  ref: { source: string; priority: number; confidence: number; value: EnvelopeSlots[S] },
): void {
  let bucket = buckets[slot] as ContributionRef<S>[] | undefined;
  if (!bucket) {
    bucket = [];
    (buckets as Record<string, unknown>)[slot] = bucket;
  }
  bucket.push(ref);
}

// ─── Merge: apply per-slot rule to each bucket ──────────────────────────────

function applyMerges(
  buckets: ContributionBuckets,
  overrides: AggregatorConfig["mergeOverrides"] | undefined,
): Partial<EnvelopeSlots> {
  const out: Partial<EnvelopeSlots> = {};
  for (const slot of Object.keys(buckets) as Array<keyof EnvelopeSlots>) {
    const refs = buckets[slot];
    if (!refs || refs.length === 0) continue;
    const merge = (overrides?.[slot] ?? DEFAULT_MERGES[slot]) as MergeFn<typeof slot>;
    const merged = merge(refs as ContributionRef<typeof slot>[]);
    if (merged !== undefined) {
      (out as Record<string, unknown>)[slot] = merged;
    }
  }
  return out;
}

// ─── Default merge rules per slot ───────────────────────────────────────────

const DEFAULT_MERGES: { [S in keyof EnvelopeSlots]: MergeFn<S> } = {
  relevant_conversation_history: (refs) => {
    // "Superset wins" — pick the longest array. When tied, use priority/
    // confidence ordering as a tiebreak via `pickHighest`.
    if (refs.length === 0) return undefined;
    let best = refs[0];
    for (let i = 1; i < refs.length; i++) {
      if (refs[i].value.length > best.value.length) best = refs[i];
    }
    return best.value;
  },
  requires_full_message_history: (refs) =>
    refs.length === 0 ? undefined : refs.some((r) => r.value === true),
  memory_queries: (refs) => {
    if (refs.length === 0) return undefined;
    return dedupeStrings(refs.flatMap((r) => r.value));
  },
  tool_families: (refs) => {
    if (refs.length === 0) return undefined;
    return dedupeStrings(refs.flatMap((r) => r.value));
  },
  safety_signals: (refs) => {
    if (refs.length === 0) return undefined;
    let highest = refs[0];
    for (let i = 1; i < refs.length; i++) {
      if (
        SECURITY_RISK_ORDER[refs[i].value.risk_level] >
        SECURITY_RISK_ORDER[highest.value.risk_level]
      ) {
        highest = refs[i];
      }
    }
    return {
      risk_level: highest.value.risk_level,
      signals: dedupeStrings(refs.flatMap((r) => r.value.signals)),
    };
  },
  handoff: pickHighest,
  expected_response_length: pickHighest,
  output_format_hint: pickHighest,
  language: pickHighest,
  pii: (refs) => {
    if (refs.length === 0) return undefined;
    return {
      present: refs.some((r) => r.value.present),
      categories: dedupeStrings(refs.flatMap((r) => r.value.categories)),
    };
  },
  attachment_relevance: (refs) => {
    if (refs.length === 0) return undefined;
    const byHash = new Map<string, EnvelopeSlots["attachment_relevance"][number]>();
    for (const r of refs) {
      for (const item of r.value) {
        const existing = byHash.get(item.hash);
        if (!existing) {
          byHash.set(item.hash, { ...item });
        } else if (item.keep && !existing.keep) {
          // keep-wins resolution
          byHash.set(item.hash, { ...item });
        }
      }
    }
    return Array.from(byHash.values());
  },
};

// Higher value = more severe; used to compare risk levels deterministically.
const SECURITY_RISK_ORDER: Record<SecurityRiskLevel, number> = {
  normal: 0,
  unable_to_determine: 1,
  suspicious: 2,
  high_risk: 3,
};

// Generic "highest priority wins; tiebreak by confidence, then by first-seen"
// merge. Works for any slot type because it just returns one contributor's
// raw value untouched.
function pickHighest<S extends keyof EnvelopeSlots>(
  refs: ReadonlyArray<ContributionRef<S>>,
): EnvelopeSlots[S] | undefined {
  if (refs.length === 0) return undefined;
  let best = refs[0];
  for (let i = 1; i < refs.length; i++) {
    const r = refs[i];
    if (
      r.priority < best.priority ||
      (r.priority === best.priority && r.confidence > best.confidence)
    ) {
      best = r;
    }
  }
  return best.value;
}

function dedupeStrings<T extends string>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function composeStockSignals(
  results: Readonly<Record<string, ClassifierResultBase>>,
  threshold: number,
): Pick<Envelope, "routing" | "context" | "tools" | "safety"> {
  return {
    ...stockRouting(results, threshold),
    ...stockContext(results),
    ...stockTools(results),
    ...stockSafety(results),
  };
}

function stockRouting(
  results: Readonly<Record<string, ClassifierResultBase>>,
  threshold: number,
): { routing?: StockRoutingSignal } {
  const routing = results[ROUTING_NAME] as RoutingSignal | undefined;
  const specialization = results[MODEL_SPECIALIZATION_NAME] as
    | ModelSpecializationSignal
    | undefined;
  const out: {
    execution_mode?: StockRoutingSignal["execution_mode"];
    model_tier?: StockRoutingSignal["model_tier"];
    specialization?: StockRoutingSignal["specialization"];
  } = {};

  if (routing && routing.confidence >= threshold) {
    if (routing.execution_mode !== "unable_to_determine") {
      out.execution_mode = routing.execution_mode;
    }
    if (routing.model_tier !== "unable_to_determine") {
      out.model_tier = routing.model_tier;
    }
  }
  if (
    specialization &&
    specialization.confidence >= threshold &&
    specialization.model_specialization !== "unclear"
  ) {
    out.specialization = specialization.model_specialization;
  }

  return Object.keys(out).length === 0 ? {} : { routing: out };
}

function stockContext(
  results: Readonly<Record<string, ClassifierResultBase>>,
): { context?: ContextSignal } {
  const history = results.conversation_history as ConversationHistorySignal | undefined;
  if (!history || history.confidence <= 0) return {};
  if (history.requires_full_message_history) {
    return { context: { status: "insufficient" } };
  }
  if (history.is_standalone) {
    return { context: { status: "standalone" } };
  }
  if (history.prior_messages_needed > 0) {
    return {
      context: {
        status: "sufficient",
        include_prior_messages: history.prior_messages_needed,
      },
    };
  }
  return { context: { status: "unknown" } };
}

function stockTools(
  results: Readonly<Record<string, ClassifierResultBase>>,
): { tools?: ToolsSignal } {
  const tools = results.tools as ToolsClassifierSignal | undefined;
  if (!tools || tools.confidence <= 0) return {};
  const families = dedupeStrings(tools.families ?? []);
  return { tools: { required: families.length > 0, families } };
}

function stockSafety(
  results: Readonly<Record<string, ClassifierResultBase>>,
): { safety?: SafetySignal } {
  const security = results.security as SecurityClassifierSignal | undefined;
  if (!security || security.confidence <= 0) return {};
  return {
    safety: {
      risk_level:
        security.risk_level === "unable_to_determine" ? "unknown" : security.risk_level,
      signals: dedupeStrings(security.signals ?? []),
    },
  };
}

// ─── Model resolver ─────────────────────────────────────────────────────────

export function resolveModel(
  results: Readonly<Record<string, ClassifierResultBase>>,
  catalog: Catalog,
  threshold: number,
): ModelRecommendation {
  const requested: ModelRecommendationResolution["constraints_used"] = {};
  const constraints_dropped: Array<
    ModelRecommendationResolution["constraints_dropped"][number]
  > = [];
  const confidences: ModelRecommendationResolution["confidences"] = {};

  const spec = results[MODEL_SPECIALIZATION_NAME] as
    | ModelSpecializationSignal
    | undefined;
  if (spec) {
    confidences.model_specialization = spec.confidence;
    if (spec.confidence < threshold) {
      constraints_dropped.push({ axis: "specialization", reason: "low_confidence" });
    } else if (spec.model_specialization === "unclear") {
      constraints_dropped.push({ axis: "specialization", reason: "escape_hatch" });
    } else {
      requested.specialization = spec.model_specialization;
    }
  }

  const routing = results[ROUTING_NAME] as RoutingSignal | undefined;
  if (routing) {
    confidences.routing = routing.confidence;
    if (routing.confidence < threshold) {
      constraints_dropped.push({ axis: "execution_mode", reason: "low_confidence" });
      constraints_dropped.push({ axis: "tier", reason: "low_confidence" });
    } else {
      if (routing.execution_mode === "unable_to_determine") {
        constraints_dropped.push({ axis: "execution_mode", reason: "escape_hatch" });
      } else {
        requested.execution_mode = routing.execution_mode;
      }
      if (routing.model_tier === "unable_to_determine") {
        constraints_dropped.push({ axis: "tier", reason: "escape_hatch" });
      } else {
        requested.tier = routing.model_tier;
      }
    }
  }

  const passes: ReadonlyArray<{
    readonly useSpecialization: boolean;
    readonly useTier: boolean;
  }> = [
    { useSpecialization: true, useTier: true },
    { useSpecialization: true, useTier: false },
    { useSpecialization: false, useTier: true },
    { useSpecialization: false, useTier: false },
  ];

  for (const pass of passes) {
    const constraints_used = constraintsForPass(requested, pass);
    const matching = catalog.models.filter((model) => matchesConstraints(model, constraints_used));
    if (matching.length === 0) continue;

    const winner = pickBestModel(matching, catalog.models);
    return {
      ...modelRecommendationFields(winner),
      resolution: {
        constraints_used,
        constraints_dropped: [
          ...constraints_dropped,
          ...relaxedConstraints(requested, constraints_used),
        ],
        confidences,
        fell_back_to_default: false,
      },
    };
  }

  const fallback = catalog.models.find((model) => model.id === catalog.default);
  // validateCatalog guarantees the default exists; if we got here without it,
  // the catalog was bypassed and the developer wants to know.
  if (!fallback) {
    throw new Error(
      `catalog default "${catalog.default}" not found in models — catalog skipped validation`,
    );
  }

  return {
    ...modelRecommendationFields(fallback),
    resolution: {
      constraints_used: {},
      constraints_dropped: [
        ...constraints_dropped,
        ...defaultFallbackConstraints(requested),
      ],
      confidences,
      fell_back_to_default: true,
    },
  };
}

function constraintsForPass(
  requested: ModelRecommendationResolution["constraints_used"],
  pass: { readonly useSpecialization: boolean; readonly useTier: boolean },
): ModelRecommendationResolution["constraints_used"] {
  return {
    ...(requested.execution_mode === undefined
      ? {}
      : { execution_mode: requested.execution_mode }),
    ...(pass.useSpecialization && requested.specialization !== undefined
      ? { specialization: requested.specialization }
      : {}),
    ...(pass.useTier && requested.tier !== undefined ? { tier: requested.tier } : {}),
  };
}

function matchesConstraints(
  model: CatalogEntry,
  constraints: ModelRecommendationResolution["constraints_used"],
): boolean {
  return (
    (constraints.execution_mode === undefined ||
      model.execution_modes.includes(constraints.execution_mode)) &&
    (constraints.specialization === undefined ||
      model.specializations.includes(constraints.specialization)) &&
    (constraints.tier === undefined || model.tier === constraints.tier)
  );
}

function relaxedConstraints(
  requested: ModelRecommendationResolution["constraints_used"],
  used: ModelRecommendationResolution["constraints_used"],
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (requested.specialization !== undefined && used.specialization === undefined) {
    dropped.push({ axis: "specialization", reason: "no_match_relaxed" });
  }
  if (requested.tier !== undefined && used.tier === undefined) {
    dropped.push({ axis: "tier", reason: "no_match_relaxed" });
  }
  return dropped;
}

function defaultFallbackConstraints(
  requested: ModelRecommendationResolution["constraints_used"],
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (requested.specialization !== undefined) {
    dropped.push({ axis: "specialization", reason: "default_fallback" });
  }
  if (requested.execution_mode !== undefined) {
    dropped.push({ axis: "execution_mode", reason: "default_fallback" });
  }
  if (requested.tier !== undefined) {
    dropped.push({ axis: "tier", reason: "default_fallback" });
  }
  return dropped;
}

function pickBestModel(
  candidates: ReadonlyArray<CatalogEntry>,
  catalogOrder: ReadonlyArray<CatalogEntry>,
): CatalogEntry {
  let winner = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (compareModels(candidate, winner, catalogOrder) < 0) {
      winner = candidate;
    }
  }
  return winner;
}

function compareModels(
  a: CatalogEntry,
  b: CatalogEntry,
  catalogOrder: ReadonlyArray<CatalogEntry>,
): number {
  const costDiff = priceIndex(a) - priceIndex(b);
  if (Math.abs(costDiff) > Number.EPSILON) {
    return costDiff;
  }
  if (a.params_in_billions !== b.params_in_billions) {
    return b.params_in_billions - a.params_in_billions;
  }
  if (a.context_window !== b.context_window) {
    return b.context_window - a.context_window;
  }
  return catalogOrder.indexOf(a) - catalogOrder.indexOf(b);
}

function priceIndex(model: CatalogEntry): number {
  if (
    model.input_tokens_cpm === undefined ||
    model.output_tokens_cpm === undefined
  ) {
    return 0;
  }
  return model.input_tokens_cpm + model.output_tokens_cpm;
}

function modelRecommendationFields(
  winner: CatalogEntry,
): Omit<ModelRecommendation, "resolution"> {
  return {
    id: winner.id,
    params_in_billions: winner.params_in_billions,
    context_window: winner.context_window,
    ...(winner.input_tokens_cpm === undefined ? {} : { input_tokens_cpm: winner.input_tokens_cpm }),
    ...(winner.cached_tokens_cpm === undefined
      ? {}
      : { cached_tokens_cpm: winner.cached_tokens_cpm }),
    ...(winner.output_tokens_cpm === undefined
      ? {}
      : { output_tokens_cpm: winner.output_tokens_cpm }),
  };
}
