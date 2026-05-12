import type {
  AggregatorConfig,
  Catalog,
  CatalogEntry,
  ClassifierRegistry,
  ClassifierResults,
  Envelope,
  ModelRecommendation,
  ModelRecommendationResolution,
} from "./manifest.js";
import type {
  AckReplySignal,
  ClassifierOutput,
  CustomClassifierOutput,
  CustomClassifierOutputValue,
  FinalReplySignal,
  PreflightClassifierOutput,
  RoutingClassifierOutput,
  RoutingSignal,
  SafetySignal,
  SecurityClassifierOutput,
  StockClassifierName,
  ToolsClassifierOutput,
  ToolsSignal,
} from "./stock.js";
import { isCustomManifest, isStockManifest } from "./stock.js";
import type { ClassifierInput } from "./types.js";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export interface ComposeEnvelopeArgs {
  readonly registry: ClassifierRegistry;
  readonly results: ClassifierResults;
  readonly catalog: Catalog;
  readonly input: ClassifierInput;
  readonly config?: AggregatorConfig;
}

export function composeEnvelope(args: ComposeEnvelopeArgs): Envelope {
  const { registry, results, catalog, config } = args;
  const threshold = config?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const stockByName = stockResultsByName(registry, results);
  const preflight = stockByName.preflight as PreflightClassifierOutput | undefined;
  const routing = stockByName.routing as RoutingClassifierOutput | undefined;
  const modelSpec = stockByName.model_specialization as RoutingClassifierOutput | undefined;
  const tools = stockByName.tools as ToolsClassifierOutput | undefined;
  const security = stockByName.security as SecurityClassifierOutput | undefined;

  const preflightConfident = isConfident(preflight, threshold);
  const finalReply = preflightConfident ? preflight?.final_reply : undefined;
  const ackReply = preflightConfident ? preflight?.ack_reply : undefined;

  const mergedRouting = mergeRouting(routing, modelSpec, threshold);
  const lowConfidenceDrops = lowConfidenceRoutingDrops(routing, modelSpec, mergedRouting, threshold);
  const toolsSignal = isConfident(tools, threshold) ? extractToolsSignal(tools!) : undefined;
  const safety = isConfident(security, threshold) ? extractSafetySignal(security!) : undefined;

  const envelope: Envelope = {
    ...optional("final_reply", finalReply),
    ...optional("ack_reply", ackReply),
    ...optional("routing", mergedRouting),
    ...optional("tools", toolsSignal),
    ...optional("safety", safety),
    custom_outputs: customOutputs(registry, results),
    model_recommendation: resolveModelFromRouting(
      mergedRouting,
      catalog,
      routingMaxConfidence(routing, modelSpec),
      lowConfidenceDrops,
    ),
  };

  return envelope;
}

function optional<Key extends keyof Envelope>(
  key: Key,
  value: Envelope[Key] | undefined,
): Partial<Envelope> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Envelope>);
}

function stockResultsByName(
  registry: ClassifierRegistry,
  results: ClassifierResults,
): Partial<Record<StockClassifierName, ClassifierOutput>> {
  const map: Partial<Record<StockClassifierName, ClassifierOutput>> = {};
  for (const manifest of registry) {
    if (!isStockManifest(manifest)) continue;
    const result = results[manifest.name];
    if (result !== undefined) {
      map[manifest.name] = result;
    }
  }
  return map;
}

function isConfident(
  result: { confidence?: number } | undefined,
  threshold: number,
): boolean {
  if (!result) return false;
  return (result.confidence ?? 0) >= threshold;
}

function mergeRouting(
  routing: RoutingClassifierOutput | undefined,
  modelSpec: RoutingClassifierOutput | undefined,
  threshold: number,
): RoutingSignal | undefined {
  const tier = pickConfidentAxis(
    [
      ["routing", routing, routing?.model_tier],
      ["model_specialization", modelSpec, modelSpec?.model_tier],
    ],
    threshold,
  );
  const specialization = pickConfidentAxis(
    [
      ["model_specialization", modelSpec, modelSpec?.specialization],
      ["routing", routing, routing?.specialization],
    ],
    threshold,
  );
  if (tier === undefined && specialization === undefined) return undefined;
  return {
    ...(tier === undefined ? {} : { model_tier: tier }),
    ...(specialization === undefined ? {} : { specialization }),
  };
}

function pickConfidentAxis<T>(
  candidates: ReadonlyArray<[string, { confidence?: number } | undefined, T | undefined]>,
  threshold: number,
): T | undefined {
  let best: { value: T; confidence: number } | undefined;
  for (const [, source, value] of candidates) {
    if (value === undefined) continue;
    if (!isConfident(source, threshold)) continue;
    const confidence = source!.confidence ?? 0;
    if (best === undefined || confidence > best.confidence) {
      best = { value, confidence };
    }
  }
  return best?.value;
}

function routingMaxConfidence(
  routing: RoutingClassifierOutput | undefined,
  modelSpec: RoutingClassifierOutput | undefined,
): number | undefined {
  const values = [routing?.confidence, modelSpec?.confidence].filter(
    (v): v is number => typeof v === "number",
  );
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

function extractToolsSignal(result: ToolsClassifierOutput): ToolsSignal {
  return { required: result.required, families: result.families };
}

function extractSafetySignal(result: SecurityClassifierOutput): SafetySignal {
  return {
    ...(result.decision === undefined ? {} : { decision: result.decision }),
    risk_level: result.risk_level,
    signals: result.signals,
  };
}

function customOutputs(
  registry: ClassifierRegistry,
  results: ClassifierResults,
): ReadonlyArray<CustomClassifierOutput> {
  const out: CustomClassifierOutput[] = [];
  for (const manifest of registry) {
    if (!isCustomManifest(manifest)) continue;
    const result = results[manifest.name] as CustomClassifierOutputValue | undefined;
    if (result === undefined) continue;
    out.push({
      classifier: manifest.name,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
      output: result.output,
    });
  }
  return out;
}

// ─── Model recommendation ───────────────────────────────────────────────────

function lowConfidenceRoutingDrops(
  routing: RoutingClassifierOutput | undefined,
  modelSpec: RoutingClassifierOutput | undefined,
  merged: RoutingSignal | undefined,
  threshold: number,
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (merged?.specialization === undefined) {
    if (hasLowConfidenceAxis(routing, "specialization", threshold) ||
        hasLowConfidenceAxis(modelSpec, "specialization", threshold)) {
      dropped.push({ axis: "specialization", reason: "low_confidence" });
    }
  }
  if (merged?.model_tier === undefined) {
    if (hasLowConfidenceAxis(routing, "model_tier", threshold) ||
        hasLowConfidenceAxis(modelSpec, "model_tier", threshold)) {
      dropped.push({ axis: "tier", reason: "low_confidence" });
    }
  }
  return dropped;
}

function hasLowConfidenceAxis(
  result: RoutingClassifierOutput | undefined,
  field: "model_tier" | "specialization",
  threshold: number,
): boolean {
  if (!result) return false;
  if (result[field] === undefined) return false;
  return (result.confidence ?? 0) < threshold;
}

export function resolveModelFromRouting(
  routing: RoutingSignal | undefined,
  catalog: Catalog,
  confidence: number | undefined,
  ignoredConstraints: ModelRecommendationResolution["constraints_dropped"] = [],
): ModelRecommendation {
  const requested: ModelRecommendationResolution["constraints_used"] = {};
  const confidences: ModelRecommendationResolution["confidences"] = {};

  if (confidence !== undefined) {
    confidences.routing = confidence;
  }
  if (routing?.specialization !== undefined) requested.specialization = routing.specialization;
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

// Test-friendly convenience wrapper: builds a routing signal from a typed
// results map and resolves a model. Mirrors `composeEnvelope` for callers
// that want just the model recommendation without the rest of the envelope.
export function resolveModel(
  results: Readonly<{ routing?: RoutingClassifierOutput; model_specialization?: RoutingClassifierOutput }>,
  catalog: Catalog,
  threshold: number,
): ModelRecommendation {
  const routing = mergeRouting(results.routing, results.model_specialization, threshold);
  return resolveModelFromRouting(
    routing,
    catalog,
    routingMaxConfidence(results.routing, results.model_specialization),
    lowConfidenceRoutingDrops(results.routing, results.model_specialization, routing, threshold),
  );
}

function constraintsForPass(
  requested: ModelRecommendationResolution["constraints_used"],
  pass: { readonly useSpecialization: boolean; readonly useTier: boolean },
): ModelRecommendationResolution["constraints_used"] {
  return {
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

// Re-exports kept for consumers / tests.
export type { FinalReplySignal, AckReplySignal };
