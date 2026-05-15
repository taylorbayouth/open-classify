import type {
  BlockReason,
  Catalog,
  CatalogEntry,
  ClassifierPublicOutputs,
  ClassifierRegistry,
  ClassifierResults,
  PipelineAction,
  PipelineResult,
  ReplySignal,
} from "./manifest.js";
import type {
  AckReplySignal,
  Certainty,
  ClassifierOutput,
  FinalReplySignal,
  PromptInjectionSignal,
  RoutingSignal,
  ToolsSignal,
} from "./stock.js";
import { certaintyScore } from "./stock.js";
import type { DownstreamModelTier, ModelSpecialization, PromptInjectionRiskLevel } from "./enums.js";
import type { ReservedFieldName } from "./reserved-fields.js";

// Internal types for model resolution — not surfaced to callers.
interface ModelRecommendationResolution {
  readonly constraints_used: Partial<{
    model_specialization: ModelSpecialization;
    model_tier: DownstreamModelTier;
  }>;
  readonly constraints_dropped: ReadonlyArray<{
    readonly axis: "model_specialization" | "model_tier";
    readonly reason: "no_match_relaxed" | "default_fallback";
  }>;
  readonly fell_back_to_default: boolean;
}

interface ModelRecommendation {
  readonly id: string;
}

export interface AssembleResultArgs {
  readonly registry: ClassifierRegistry;
  readonly results: ClassifierResults;
  readonly failedClassifiers: ReadonlyArray<string>;
  readonly catalog: Catalog;
}

// Omit target_message_hash — pipeline adds it after assembly.
type AssembledResult = Omit<PipelineResult, "target_message_hash">;

export function assembleResult(args: AssembleResultArgs): AssembledResult {
  const { registry, results, failedClassifiers, catalog } = args;

  // Pick reserved fields — highest certainty wins, no threshold gate.
  const finalReply = pickField<FinalReplySignal>(registry, results, "final_reply");
  const ackReply = pickField<AckReplySignal>(registry, results, "ack_reply");
  const modelTier = pickField<DownstreamModelTier>(registry, results, "model_tier");
  const modelSpec = pickField<ModelSpecialization>(registry, results, "model_specialization");
  const toolsPick = pickField<ReadonlyArray<string>>(registry, results, "tools");
  const riskLevel = pickField<PromptInjectionRiskLevel>(registry, results, "risk_level");

  // Resolve concrete model id.
  let model_id: string | null = null;
  try {
    const routing = mergeRouting(modelTier?.value, modelSpec?.value);
    model_id = resolveModelFromRouting(routing, catalog).id;
  } catch {
    // Catalog error — model_id stays null.
  }

  const tools: ReadonlyArray<string> = toolsPick?.value ?? [];

  const reply: ReplySignal | null = finalReply?.value
    ? { text: finalReply.value.text }
    : ackReply?.value
    ? { text: ackReply.value.text }
    : null;

  const prompt_injection =
    riskLevel?.value !== undefined ? { risk_level: riskLevel.value } : null;

  const { avg_certainty, min_certainty } = certaintySummary(registry, results);
  const classifier_outputs = buildPublicOutputs(registry, results);

  // Determine action. Priority: prompt_injection > classification_error > reply > route.
  const isInjectionBlock =
    riskLevel?.value === "high_risk" || riskLevel?.value === "unknown";
  const isClassificationError =
    failedClassifiers.length > 0 || reply === null || model_id === null;

  let action: PipelineAction;
  let block_reason: BlockReason | undefined;

  if (isInjectionBlock) {
    action = "block";
    block_reason = "prompt_injection";
  } else if (isClassificationError) {
    action = "block";
    block_reason = "classification_error";
  } else if (finalReply?.value !== undefined) {
    action = "reply";
  } else {
    action = "route";
  }

  return {
    action,
    ...(block_reason !== undefined ? { block_reason } : {}),
    model_id,
    tools,
    reply,
    prompt_injection,
    avg_certainty,
    min_certainty,
    failed_classifiers: failedClassifiers,
    classifier_outputs,
  };
}

// Build the public classifier_outputs map. Keeps reason + payload fields;
// converts certainty label to float score.
export function buildPublicOutputs(
  registry: ClassifierRegistry,
  results: ClassifierResults,
): ClassifierPublicOutputs {
  const out: ClassifierPublicOutputs = {};
  for (const manifest of registry) {
    const result = results[manifest.name];
    if (result === undefined) continue;
    const { certainty, ...rest } = result as ClassifierOutput & { certainty: Certainty | undefined };
    out[manifest.name] = {
      ...rest,
      certainty: scoreCertainty(certainty),
    };
  }
  return out;
}

function certaintySummary(
  registry: ClassifierRegistry,
  results: ClassifierResults,
): { avg_certainty: number; min_certainty: number } {
  const scores = registry.map((m) => scoreCertainty(results[m.name]?.certainty));
  if (scores.length === 0) return { avg_certainty: 0, min_certainty: 0 };
  const min_certainty = Math.min(...scores);
  const avg_certainty = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  return { min_certainty, avg_certainty };
}

interface ReservedPick<T> {
  readonly value: T;
  readonly source: string;
  readonly score: number;
}

// Highest certainty wins; ties broken by registry order (already sorted by
// dispatch_order ascending).
function pickField<T>(
  registry: ClassifierRegistry,
  results: ClassifierResults,
  field: ReservedFieldName,
): ReservedPick<T> | undefined {
  let best: ReservedPick<T> | undefined;
  for (const manifest of registry) {
    if (!manifest.reservedFields.includes(field)) continue;
    const output = results[manifest.name];
    if (output === undefined) continue;
    const raw = output[field];
    if (raw === undefined) continue;
    const score = scoreCertainty(output.certainty);
    if (best === undefined || score > best.score) {
      best = { value: raw as T, source: manifest.name, score };
    }
  }
  return best;
}

function scoreCertainty(certainty: Certainty | undefined): number {
  return certainty === undefined ? 0 : certaintyScore[certainty];
}

// ─── Model resolution ────────────────────────────────────────────────────────

function mergeRouting(
  tier: DownstreamModelTier | undefined,
  specialization: ModelSpecialization | undefined,
): RoutingSignal | undefined {
  if (tier === undefined && specialization === undefined) return undefined;
  return {
    ...(tier === undefined ? {} : { model_tier: tier }),
    ...(specialization === undefined ? {} : { model_specialization: specialization }),
  };
}

function resolveModelFromRouting(
  routing: RoutingSignal | undefined,
  catalog: Catalog,
): ModelRecommendation {
  const requested: ModelRecommendationResolution["constraints_used"] = {};
  if (routing?.model_specialization !== undefined) {
    requested.model_specialization = routing.model_specialization;
  }
  if (routing?.model_tier !== undefined) {
    requested.model_tier = routing.model_tier;
  }

  const passes: ReadonlyArray<{ useSpec: boolean; useTier: boolean }> = [
    { useSpec: true, useTier: true },
    { useSpec: true, useTier: false },
    { useSpec: false, useTier: true },
    { useSpec: false, useTier: false },
  ];

  for (const pass of passes) {
    const constraints = constraintsForPass(requested, pass);
    const matching = catalog.models.filter((m) => matchesConstraints(m, constraints));
    if (matching.length === 0) continue;
    return { id: pickBestModel(matching, catalog.models).id };
  }

  const fallback = catalog.models.find((m) => m.id === catalog.default);
  if (!fallback) {
    throw new Error(
      `catalog default "${catalog.default}" not found in models`,
    );
  }
  return { id: fallback.id };
}

function constraintsForPass(
  requested: ModelRecommendationResolution["constraints_used"],
  pass: { useSpec: boolean; useTier: boolean },
): ModelRecommendationResolution["constraints_used"] {
  return {
    ...(pass.useSpec && requested.model_specialization !== undefined
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

function pickBestModel(
  candidates: ReadonlyArray<CatalogEntry>,
  catalogOrder: ReadonlyArray<CatalogEntry>,
): CatalogEntry {
  let winner = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (compareModels(candidates[i], winner, catalogOrder) < 0) {
      winner = candidates[i];
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
  if (a.context_window !== b.context_window) return b.context_window - a.context_window;
  return catalogOrder.indexOf(a) - catalogOrder.indexOf(b);
}

function priceIndex(model: CatalogEntry): number {
  if (model.input_tokens_cpm === undefined || model.output_tokens_cpm === undefined) return 0;
  return model.input_tokens_cpm + model.output_tokens_cpm;
}

function comparableParams(model: CatalogEntry): number {
  return model.params_in_billions ?? 0;
}

export type { FinalReplySignal, AckReplySignal, ToolsSignal };
