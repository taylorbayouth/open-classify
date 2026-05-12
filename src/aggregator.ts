import type {
  AggregatorConfig,
  Catalog,
  CatalogEntry,
  ClassifierRegistry,
  ClassifierResults,
  ConcreteDownstreamExecutionMode,
  ConcreteDownstreamModelTier,
  ConcreteModelSpecialization,
  Envelope,
  ModelRecommendation,
  ModelRecommendationResolution,
} from "./manifest.js";
import type {
  ContextSignal,
  HandoffSignal,
  ResponseSignal,
  RoutingSignal,
  SafetySignal,
  StockClassifierOutput,
  SummarySignal,
  ToolsSignal,
} from "./stock.js";
import type { ClassifierInput } from "./types.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export interface ComposeEnvelopeArgs {
  readonly registry: ClassifierRegistry;
  readonly results: ClassifierResults;
  readonly catalog: Catalog;
  readonly input: ClassifierInput;
  readonly config?: AggregatorConfig;
}

interface Candidate<T> {
  readonly value: T;
  readonly order: number;
  readonly confidence: number;
}

export function composeEnvelope(args: ComposeEnvelopeArgs): Envelope {
  const { registry, results, catalog, config } = args;
  const threshold = config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const orderByName = new Map(registry.map((m) => [m.name, m.order]));
  const confident = Object.entries(results).filter(
    ([, result]) => result.confidence >= threshold,
  );

  const routing = mergeRouting(confident, orderByName);
  const lowConfidenceDrops = lowConfidenceRoutingDrops(Object.entries(results), routing, threshold);
  const envelope: Envelope = {
    ...optional("handoff", pickHighestSignal(confident, orderByName, "handoff")),
    ...optional("routing", routing),
    ...optional("context", pickHighestSignal(confident, orderByName, "context")),
    ...optional("tools", mergeTools(confident)),
    ...optional("response", pickHighestSignal(confident, orderByName, "response")),
    ...optional("safety", mergeSafety(confident)),
    ...optional("summary", pickHighestSignal(confident, orderByName, "summary")),
    custom_outputs: customOutputs(results),
    model_recommendation: resolveModelFromRouting(
      routing,
      catalog,
      routingConfidence(confident),
      lowConfidenceDrops,
    ),
  };

  return envelope;
}

function optional<Key extends keyof Envelope>(
  key: Key,
  value: Envelope[Key] | undefined,
): Partial<Envelope> {
  return value === undefined ? {} : { [key]: value } as Partial<Envelope>;
}

function pickHighestSignal<Key extends keyof Pick<
  StockClassifierOutput,
  "handoff" | "context" | "response" | "summary"
>>(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
  orderByName: ReadonlyMap<string, number>,
  key: Key,
): StockClassifierOutput[Key] | undefined {
  const candidates = entries
    .map(([name, result]) => signalCandidate(result[key], name, result.confidence, orderByName))
    .filter((item): item is Candidate<NonNullable<StockClassifierOutput[Key]>> => item !== undefined);
  return pickHighest(candidates);
}

function signalCandidate<T>(
  value: T | undefined,
  name: string,
  confidence: number,
  orderByName: ReadonlyMap<string, number>,
): Candidate<T> | undefined {
  return value === undefined
    ? undefined
    : { value, order: orderByName.get(name) ?? Number.MAX_SAFE_INTEGER, confidence };
}

function pickHighest<T>(candidates: ReadonlyArray<Candidate<T>>): T | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (
      candidate.order < best.order ||
      (candidate.order === best.order && candidate.confidence > best.confidence)
    ) {
      best = candidate;
    }
  }
  return best.value;
}

function mergeRouting(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
  orderByName: ReadonlyMap<string, number>,
): RoutingSignal | undefined {
  const out: {
    execution_mode?: RoutingSignal["execution_mode"];
    model_tier?: RoutingSignal["model_tier"];
    specialization?: RoutingSignal["specialization"];
  } = {};
  for (const key of ["execution_mode", "model_tier", "specialization"] as const) {
    const value = pickHighest(
      entries
        .map(([name, result]) =>
          signalCandidate(result.routing?.[key], name, result.confidence, orderByName),
        )
        .filter((item): item is Candidate<NonNullable<RoutingSignal[typeof key]>> => item !== undefined),
    );
    if (value === undefined) continue;
    if (key === "execution_mode") out.execution_mode = value as RoutingSignal["execution_mode"];
    if (key === "model_tier") out.model_tier = value as RoutingSignal["model_tier"];
    if (key === "specialization") out.specialization = value as RoutingSignal["specialization"];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function routingConfidence(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
): number | undefined {
  let confidence: number | undefined;
  for (const [, result] of entries) {
    if (result.routing === undefined) continue;
    confidence = Math.max(confidence ?? 0, result.confidence);
  }
  return confidence;
}

function mergeTools(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
): ToolsSignal | undefined {
  const families = dedupeStrings(entries.flatMap(([, result]) => result.tools?.families ?? []));
  if (families.length === 0) {
    return entries.some(([, result]) => result.tools !== undefined)
      ? { required: false, families: [] }
      : undefined;
  }
  return { required: true, families };
}

const SAFETY_RISK_ORDER: Record<SafetySignal["risk_level"], number> = {
  normal: 0,
  unknown: 1,
  suspicious: 2,
  high_risk: 3,
};

const SAFETY_DECISION_ORDER: Record<NonNullable<SafetySignal["decision"]>, number> = {
  allow: 0,
  needs_review: 1,
  block: 2,
};

function mergeSafety(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
): SafetySignal | undefined {
  const safetyEntries = entries.flatMap(([, result]) => result.safety ? [result.safety] : []);
  if (safetyEntries.length === 0) return undefined;
  let risk_level = safetyEntries[0].risk_level;
  let decision = safetyEntries[0].decision;
  for (const safety of safetyEntries) {
    if (SAFETY_RISK_ORDER[safety.risk_level] > SAFETY_RISK_ORDER[risk_level]) {
      risk_level = safety.risk_level;
    }
    if (
      safety.decision !== undefined &&
      (decision === undefined ||
        SAFETY_DECISION_ORDER[safety.decision] > SAFETY_DECISION_ORDER[decision])
    ) {
      decision = safety.decision;
    }
  }
  return {
    ...(decision === undefined ? {} : { decision }),
    risk_level,
    signals: dedupeStrings(safetyEntries.flatMap((safety) => safety.signals)),
  };
}

function customOutputs(results: ClassifierResults): Envelope["custom_outputs"] {
  return Object.entries(results)
    .filter(([, result]) => result.output !== undefined)
    .map(([classifier, result]) => ({
      classifier,
      reason: result.reason,
      confidence: result.confidence,
      output: result.output,
    }));
}

function dedupeStrings<T extends string>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

export function resolveModelFromRouting(
  routing: RoutingSignal | undefined,
  catalog: Catalog,
  confidence: number | undefined,
  ignoredConstraints: ModelRecommendationResolution["constraints_dropped"] = [],
): ModelRecommendation {
  const requested: ModelRecommendationResolution["constraints_used"] = {};
  const constraints_dropped: Array<
    ModelRecommendationResolution["constraints_dropped"][number]
  > = [];
  const confidences: ModelRecommendationResolution["confidences"] = {};

  if (confidence !== undefined) {
    confidences.routing = confidence;
  }
  if (routing?.specialization !== undefined) requested.specialization = routing.specialization;
  if (routing?.execution_mode !== undefined) requested.execution_mode = routing.execution_mode;
  if (routing?.model_tier !== undefined) requested.tier = routing.model_tier;

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
          ...ignoredConstraints,
          ...relaxedConstraints(requested, constraints_used),
        ],
        confidences,
        fell_back_to_default: false,
      },
    };
  }

  const fallback = catalog.models.find((model) => model.id === catalog.default);
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
        ...ignoredConstraints,
        ...defaultFallbackConstraints(requested),
      ],
      confidences,
      fell_back_to_default: true,
    },
  };
}

export function resolveModel(
  results: Readonly<Record<string, StockClassifierOutput>>,
  catalog: Catalog,
  threshold: number,
): ModelRecommendation {
  const allEntries = Object.entries(results);
  const entries = allEntries.filter(([, result]) => result.confidence >= threshold);
  const routing = mergeRouting(entries, new Map());
  return resolveModelFromRouting(
    routing,
    catalog,
    routingConfidence(entries),
    lowConfidenceRoutingDrops(allEntries, routing, threshold),
  );
}

function lowConfidenceRoutingDrops(
  entries: ReadonlyArray<[string, StockClassifierOutput]>,
  routing: RoutingSignal | undefined,
  threshold: number,
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  const axes: ReadonlyArray<{
    readonly key: keyof RoutingSignal;
    readonly axis: "specialization" | "execution_mode" | "tier";
  }> = [
    { key: "specialization", axis: "specialization" },
    { key: "execution_mode", axis: "execution_mode" },
    { key: "model_tier", axis: "tier" },
  ];
  for (const { key, axis } of axes) {
    if (routing?.[key] !== undefined) continue;
    if (entries.some(([, result]) => result.confidence < threshold && result.routing?.[key] !== undefined)) {
      dropped.push({ axis, reason: "low_confidence" });
    }
  }
  return dropped;
}

function constraintsForPass(
  requested: ModelRecommendationResolution["constraints_used"],
  pass: { readonly useSpecialization: boolean; readonly useTier: boolean },
): ModelRecommendationResolution["constraints_used"] {
  return {
    ...(requested.execution_mode === undefined ? {} : { execution_mode: requested.execution_mode }),
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
  if (Math.abs(costDiff) > Number.EPSILON) return costDiff;
  if (a.params_in_billions !== b.params_in_billions) {
    return comparableParams(b) - comparableParams(a);
  }
  if (a.context_window !== b.context_window) {
    return b.context_window - a.context_window;
  }
  return catalogOrder.indexOf(a) - catalogOrder.indexOf(b);
}

function priceIndex(model: CatalogEntry): number {
  if (model.input_tokens_cpm === undefined || model.output_tokens_cpm === undefined) {
    return 0;
  }
  return model.input_tokens_cpm + model.output_tokens_cpm;
}

function comparableParams(model: CatalogEntry): number {
  return model.params_in_billions ?? 0;
}

function modelRecommendationFields(
  winner: CatalogEntry,
): Omit<ModelRecommendation, "resolution"> {
  return {
    id: winner.id,
    params_in_billions: winner.params_in_billions,
    context_window: winner.context_window,
    ...(winner.input_tokens_cpm === undefined ? {} : { input_tokens_cpm: winner.input_tokens_cpm }),
    ...(winner.cached_tokens_cpm === undefined ? {} : { cached_tokens_cpm: winner.cached_tokens_cpm }),
    ...(winner.output_tokens_cpm === undefined ? {} : { output_tokens_cpm: winner.output_tokens_cpm }),
  };
}
