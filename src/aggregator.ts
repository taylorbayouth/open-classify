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
  Certainty,
  ClassifierAuditOutput,
  ClassifierOutput,
  FinalReplySignal,
  PromptInjectionSignal,
  RoutingSignal,
  ToolsSignal,
} from "./stock.js";
import { certaintyScore } from "./stock.js";
import type { DownstreamModelTier, ModelSpecialization } from "./enums.js";
import type { ReservedFieldName } from "./reserved-fields.js";
import type { ClassifierInput } from "./types.js";

export const DEFAULT_CERTAINTY_THRESHOLD = 0.65;
/** @deprecated Use DEFAULT_CERTAINTY_THRESHOLD. */
export const DEFAULT_CONFIDENCE_THRESHOLD = DEFAULT_CERTAINTY_THRESHOLD;

export interface ComposeEnvelopeArgs {
  readonly registry: ClassifierRegistry;
  readonly results: ClassifierResults;
  readonly catalog: Catalog;
  readonly input: ClassifierInput;
  readonly config?: AggregatorConfig;
}

export function composeEnvelope(args: ComposeEnvelopeArgs): Envelope {
  const { registry, results, catalog, config } = args;
  const threshold = certaintyThreshold(config);

  const finalReplyPick = pickReservedField<FinalReplySignal>(registry, results, "final_reply", threshold);
  const ackReplyPick = pickReservedField<AckReplySignal>(registry, results, "ack_reply", threshold);
  const tierPick = pickReservedField<DownstreamModelTier>(registry, results, "model_tier", threshold);
  const specPick = pickReservedField<ModelSpecialization>(registry, results, "model_specialization", threshold);
  const toolsPick = pickReservedField<ReadonlyArray<string>>(registry, results, "tools", threshold);
  const riskLevelPick = pickReservedField<PromptInjectionSignal["risk_level"]>(
    registry,
    results,
    "risk_level",
    threshold,
  );

  const routing = mergeRouting(tierPick?.value, specPick?.value);
  const routingConfidence = maxConfidence([tierPick?.confidence, specPick?.confidence]);
  const routingDrops = lowConfidenceRoutingDrops(registry, results, threshold, routing);

  const envelope: Envelope = {
    ...optional("final_reply", finalReplyPick?.value),
    ...optional("ack_reply", ackReplyPick?.value),
    ...optional("routing", routing),
    ...optional("tools", toolsPick?.value === undefined ? undefined : { tools: toolsPick.value }),
    ...optional(
      "prompt_injection",
      riskLevelPick?.value === undefined ? undefined : { risk_level: riskLevelPick.value },
    ),
    classifier_outputs: buildAuditOutputs(registry, results),
    model_recommendation: resolveModelFromRouting(routing, catalog, routingConfidence, routingDrops),
  };

  return envelope;
}

export function certaintyThreshold(config: AggregatorConfig | undefined): number {
  return config?.certaintyThreshold ?? DEFAULT_CERTAINTY_THRESHOLD;
}

function optional<Key extends keyof Envelope>(
  key: Key,
  value: Envelope[Key] | undefined,
): Partial<Envelope> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Envelope>);
}

interface ReservedPick<T> {
  readonly value: T;
  readonly confidence: number;
  readonly source: string;
}

// Highest-certainty contributor wins. Ties broken by registry order — the
// registry is already sorted by `dispatch_order` ascending (classifiers without
// dispatch_order sort last), and we iterate in that order, so the first
// encountered tie keeps the slot.
function pickReservedField<T>(
  registry: ClassifierRegistry,
  results: ClassifierResults,
  field: ReservedFieldName,
  threshold: number,
): ReservedPick<T> | undefined {
  let best: ReservedPick<T> | undefined;
  for (const manifest of registry) {
    if (!manifest.reservedFields.includes(field)) continue;
    const output = results[manifest.name];
    if (output === undefined) continue;
    const raw = output[field];
    if (raw === undefined) continue;
    const confidence = scoreCertainty(output.certainty);
    if (confidence < threshold) continue;
    if (best === undefined || confidence > best.confidence) {
      best = { value: raw as T, confidence, source: manifest.name };
    }
  }
  return best;
}

function mergeRouting(
  tier: DownstreamModelTier | undefined,
  model_specialization: ModelSpecialization | undefined,
): RoutingSignal | undefined {
  if (tier === undefined && model_specialization === undefined) return undefined;
  return {
    ...(tier === undefined ? {} : { model_tier: tier }),
    ...(model_specialization === undefined ? {} : { model_specialization }),
  };
}

function maxConfidence(values: ReadonlyArray<number | undefined>): number | undefined {
  const finite = values.filter((v): v is number => v !== undefined);
  if (finite.length === 0) return undefined;
  return Math.max(...finite);
}

function buildAuditOutputs(
  registry: ClassifierRegistry,
  results: ClassifierResults,
): ReadonlyArray<ClassifierAuditOutput> {
  const out: ClassifierAuditOutput[] = [];
  for (const manifest of registry) {
    const result = results[manifest.name];
    if (result === undefined) continue;
    out.push({ classifier: manifest.name, ...result });
  }
  return out;
}

// ─── Model recommendation ───────────────────────────────────────────────────

function lowConfidenceRoutingDrops(
  registry: ClassifierRegistry,
  results: ClassifierResults,
  threshold: number,
  merged: RoutingSignal | undefined,
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (merged?.model_tier === undefined && hasLowConfidenceReservedField(registry, results, "model_tier", threshold)) {
    dropped.push({ axis: "model_tier", reason: "low_confidence" });
  }
  if (
    merged?.model_specialization === undefined &&
    hasLowConfidenceReservedField(registry, results, "model_specialization", threshold)
  ) {
    dropped.push({ axis: "model_specialization", reason: "low_confidence" });
  }
  return dropped;
}

function hasLowConfidenceReservedField(
  registry: ClassifierRegistry,
  results: ClassifierResults,
  field: ReservedFieldName,
  threshold: number,
): boolean {
  for (const manifest of registry) {
    if (!manifest.reservedFields.includes(field)) continue;
    const output = results[manifest.name];
    if (output === undefined) continue;
    if (output[field] === undefined) continue;
    if (scoreCertainty(output.certainty) < threshold) return true;
  }
  return false;
}

function scoreCertainty(certainty: Certainty | undefined): number {
  return certainty === undefined ? 0 : certaintyScore[certainty];
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
  if (routing?.model_specialization !== undefined) {
    requested.model_specialization = routing.model_specialization;
  }
  if (routing?.model_tier !== undefined) {
    requested.model_tier = routing.model_tier;
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

// Test-friendly convenience wrapper: given typed result outputs for the
// routing-bearing classifiers, merge their reserved fields and resolve a
// model.
export function resolveModel(
  results: Readonly<{
    routing?: { model_tier?: DownstreamModelTier; certainty?: Certainty };
    model_specialization?: { model_specialization?: ModelSpecialization; certainty?: Certainty };
  }>,
  catalog: Catalog,
  threshold: number,
): ModelRecommendation {
  const routingCert = scoreCertainty(results.routing?.certainty);
  const specCert = scoreCertainty(results.model_specialization?.certainty);
  const tier = routingCert >= threshold ? results.routing?.model_tier : undefined;
  const model_specialization =
    specCert >= threshold ? results.model_specialization?.model_specialization : undefined;
  const merged = mergeRouting(tier, model_specialization);

  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (tier === undefined && results.routing?.model_tier !== undefined && routingCert < threshold) {
    dropped.push({ axis: "model_tier", reason: "low_confidence" });
  }
  if (
    model_specialization === undefined &&
    results.model_specialization?.model_specialization !== undefined &&
    specCert < threshold
  ) {
    dropped.push({ axis: "model_specialization", reason: "low_confidence" });
  }

  const confidence = maxConfidence([
    results.routing?.certainty === undefined ? undefined : routingCert,
    results.model_specialization?.certainty === undefined ? undefined : specCert,
  ]);

  return resolveModelFromRouting(merged, catalog, confidence, dropped);
}

function constraintsForPass(
  requested: ModelRecommendationResolution["constraints_used"],
  pass: { readonly useSpecialization: boolean; readonly useTier: boolean },
): ModelRecommendationResolution["constraints_used"] {
  return {
    ...(pass.useSpecialization && requested.model_specialization !== undefined
      ? { model_specialization: requested.model_specialization }
      : {}),
    ...(pass.useTier && requested.model_tier !== undefined
      ? { model_tier: requested.model_tier }
      : {}),
  };
}

function matchesConstraints(
  model: CatalogEntry,
  constraints: ModelRecommendationResolution["constraints_used"],
): boolean {
  return (
    (constraints.model_specialization === undefined ||
      model.specializations.includes(constraints.model_specialization)) &&
    (constraints.model_tier === undefined || model.tier === constraints.model_tier)
  );
}

function relaxedConstraints(
  requested: ModelRecommendationResolution["constraints_used"],
  used: ModelRecommendationResolution["constraints_used"],
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (requested.model_specialization !== undefined && used.model_specialization === undefined) {
    dropped.push({ axis: "model_specialization", reason: "no_match_relaxed" });
  }
  if (requested.model_tier !== undefined && used.model_tier === undefined) {
    dropped.push({ axis: "model_tier", reason: "no_match_relaxed" });
  }
  return dropped;
}

function defaultFallbackConstraints(
  requested: ModelRecommendationResolution["constraints_used"],
): ModelRecommendationResolution["constraints_dropped"] {
  const dropped: Array<ModelRecommendationResolution["constraints_dropped"][number]> = [];
  if (requested.model_specialization !== undefined) {
    dropped.push({ axis: "model_specialization", reason: "default_fallback" });
  }
  if (requested.model_tier !== undefined) {
    dropped.push({ axis: "model_tier", reason: "default_fallback" });
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

export type { FinalReplySignal, AckReplySignal, ToolsSignal };
