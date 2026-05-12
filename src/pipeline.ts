import { composeEnvelope } from "./aggregator.js";
import {
  CLASSIFIER_NAMES,
  MODULES_BY_NAME,
  REGISTRY,
  type RunClassifier,
} from "./classifiers.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  AggregatorConfig,
  Catalog,
  ClassifierEntry,
  ClassifierCustomOutputs,
  ClassifierResults,
  DownstreamPayload,
  Envelope,
  PipelineMeta,
  PipelineResult,
} from "./manifest.js";
import type {
  ClassifierOutput,
  CustomClassifierOutputValue,
  PreflightClassifierOutput,
  SafetySignal,
  SecurityClassifierOutput,
} from "./stock.js";
import { isCustomManifest } from "./stock.js";
import type {
  ClassifierFallbackReason,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;

export class OpenClassifyNormalizationError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "OpenClassifyNormalizationError";
  }
}

export interface ClassifyOptions {
  runClassifier: RunClassifier;
  catalog: Catalog;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  aggregator?: AggregatorConfig;
  signal?: AbortSignal;
}

type SettledClassifierResult =
  | { ok: true; name: string; value: ClassifierOutput }
  | { ok: false; name: string; error: unknown; reason: ClassifierFallbackReason };

// Short-circuit gates are intrinsic to specific stock signals — not configured
// per-manifest. preflight.final_reply ⇒ answer; security.decision in
// {block, needs_review} ⇒ block / needs_review. Order matters: preflight is
// cheaper to evaluate, so we check it first.
const SHORT_CIRCUIT_GATES = ["preflight", "security"] as const;

export async function classifyOpenClassifyInput(
  input: OpenClassifyInput,
  options: ClassifyOptions,
): Promise<PipelineResult> {
  let request: NormalizedOpenClassifyInput;
  try {
    request = normalizeOpenClassifyInput(input);
  } catch (error) {
    throw new OpenClassifyNormalizationError(error);
  }

  const controller = new AbortController();
  const abortFromOptions = (): void => {
    controller.abort(options.signal?.reason ?? new Error("classification aborted"));
  };
  if (options.signal?.aborted) {
    abortFromOptions();
  } else {
    options.signal?.addEventListener("abort", abortFromOptions, { once: true });
  }

  const classifierInput = toClassifierInput(request);
  const classifierTimeoutMs = options.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const classifierRetryCount = options.classifierRetryCount ?? DEFAULT_CLASSIFIER_RETRY_COUNT;
  const threshold = options.aggregator?.confidenceThreshold ?? 0.6;

  const runs = new Map<string, Promise<SettledClassifierResult>>(
    CLASSIFIER_NAMES.map((name) => [
      name,
      runClassifierWithRetry(
        name,
        classifierInput,
        options.runClassifier,
        controller.signal,
        classifierTimeoutMs,
        classifierRetryCount,
      ),
    ]),
  );

  try {
    for (const gate of SHORT_CIRCUIT_GATES) {
      const gateRun = runs.get(gate);
      if (gateRun === undefined) continue;
      const settled = await gateRun;
      if (!settled.ok) continue;

      const verdict = shortCircuitVerdict(gate, settled.value, threshold);
      if (!verdict) continue;

      controller.abort();
      await settleClassifierRunsExcept(runs, [gate]);
      return buildShortCircuitResult(gate, verdict, settled, request.target_message_hash);
    }

    const settled = await Promise.all([...runs.values()]);
    const { results, meta } = collectFullEntries(settled);
    const envelope = composeEnvelope({
      registry: REGISTRY,
      results,
      catalog: options.catalog,
      input: classifierInput,
      config: options.aggregator,
    });

    return buildRouteResult(request, envelope, results, meta);
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

type ShortCircuitVerdict =
  | { kind: "answer"; reply: string }
  | { kind: "block"; safety: SafetySignal }
  | { kind: "needs_review"; safety: SafetySignal };

function shortCircuitVerdict(
  gate: (typeof SHORT_CIRCUIT_GATES)[number],
  result: ClassifierOutput,
  threshold: number,
): ShortCircuitVerdict | null {
  const confidence = (result as { confidence?: number }).confidence ?? 0;
  if (confidence < threshold) return null;

  if (gate === "preflight") {
    const preflight = result as PreflightClassifierOutput;
    if (preflight.final_reply !== undefined) {
      return { kind: "answer", reply: preflight.final_reply.reply };
    }
    return null;
  }

  if (gate === "security") {
    const security = result as SecurityClassifierOutput;
    if (security.decision === "block") {
      return {
        kind: "block",
        safety: extractSafety(security),
      };
    }
    if (security.decision === "needs_review") {
      return {
        kind: "needs_review",
        safety: extractSafety(security),
      };
    }
  }

  return null;
}

function extractSafety(value: SecurityClassifierOutput): SafetySignal {
  return {
    ...(value.decision === undefined ? {} : { decision: value.decision }),
    risk_level: value.risk_level,
    signals: value.signals,
  };
}

function buildShortCircuitResult(
  name: string,
  verdict: ShortCircuitVerdict,
  settled: SettledClassifierResult,
  target_message_hash: string,
): PipelineResult {
  const manifest = MODULES_BY_NAME[name];
  const value = settled.ok ? settled.value : manifest.fallback;
  const entry: ClassifierEntry = {
    ...value,
    status: classifierRunStatus(settled),
    version: manifest.version,
  } as ClassifierEntry;
  const meta: PipelineMeta = { classifiers: { [name]: entry } };
  const classifier_outputs = classifierCustomOutputs({ [name]: value });

  if (verdict.kind === "answer") {
    const preflight = value as PreflightClassifierOutput;
    return {
      action: "answer",
      message_id: target_message_hash,
      reply: verdict.reply,
      reason: "already_answered",
      classifier_outputs,
      audit: {
        fired_by: name,
        ...(preflight.final_reply === undefined ? {} : { final_reply: preflight.final_reply }),
        meta,
      },
    };
  }
  if (verdict.kind === "needs_review") {
    return {
      action: "needs_review",
      message_id: target_message_hash,
      fired_by: name,
      reason: {
        risk_level: verdict.safety.risk_level,
        signals: verdict.safety.signals,
      },
      classifier_outputs,
      audit: {
        fired_by: name,
        safety: verdict.safety,
        meta,
      },
    };
  }
  return {
    action: "block",
    message_id: target_message_hash,
    reason: {
      risk_level: verdict.safety.risk_level,
      signals: verdict.safety.signals,
    },
    classifier_outputs,
    audit: {
      fired_by: name,
      safety: verdict.safety,
      meta,
    },
  };
}

function collectFullEntries(settled: SettledClassifierResult[]): {
  results: ClassifierResults;
  meta: PipelineMeta;
} {
  const results: ClassifierResults = {};
  const classifiers: Record<string, ClassifierEntry> = {};
  for (const s of settled) {
    const manifest = MODULES_BY_NAME[s.name];
    const value = s.ok ? s.value : manifest.fallback;
    results[s.name] = value;
    classifiers[s.name] = {
      ...value,
      status: classifierRunStatus(s),
      version: manifest.version,
    } as ClassifierEntry;
  }
  return { results, meta: { classifiers } };
}

function buildRouteResult(
  request: NormalizedOpenClassifyInput,
  envelope: Envelope,
  results: ClassifierResults,
  meta: PipelineMeta,
): PipelineResult {
  const downstream: DownstreamPayload = {
    model_id: envelope.model_recommendation.id,
    messages: request.messages,
    target_message: {
      role: "user",
      text: request.text,
      hash: request.target_message_hash,
    },
    tools: envelope.tools ?? { tools: [] },
    attachments: request.attachments,
  };

  return {
    action: "route",
    message_id: request.target_message_hash,
    downstream,
    classifier_outputs: classifierCustomOutputs(results),
    audit: {
      ...envelope,
      meta,
    },
  };
}

function classifierCustomOutputs(results: ClassifierResults): ClassifierCustomOutputs {
  const out: ClassifierCustomOutputs = {};
  for (const manifest of REGISTRY) {
    if (!isCustomManifest(manifest)) continue;
    const result = results[manifest.name] as CustomClassifierOutputValue | undefined;
    if (result === undefined) continue;
    out[manifest.name] = result.output;
  }
  return out;
}

async function runClassifierWithRetry(
  name: string,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
  retryCount: number,
): Promise<SettledClassifierResult> {
  let lastError: unknown = new Error(`${name} classifier did not run`);
  let lastReason: ClassifierFallbackReason = "error";

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (rootSignal.aborted) break;
    const result = await runClassifierAttempt(name, input, runClassifier, rootSignal, timeoutMs);
    if (result.ok) return { ok: true, name, value: result.value };
    lastError = result.error;
    lastReason = result.reason;
  }

  return { ok: false, name, error: lastError, reason: lastReason };
}

async function runClassifierAttempt(
  name: string,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
): Promise<
  | { ok: true; value: ClassifierOutput }
  | { ok: false; error: unknown; reason: ClassifierFallbackReason }
> {
  const controller = new AbortController();
  const timeoutError = new Error(`${name} classifier timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortAttempt: (() => void) | undefined;

  try {
    const run = runClassifier(name, input, controller.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error, reason: "error" as const }),
    );
    const timedOut = new Promise<{ ok: false; error: unknown; reason: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        resolve({ ok: false, error: timeoutError, reason: "timeout" });
      }, timeoutMs);
    });
    const aborted = new Promise<{ ok: false; error: unknown; reason: "error" }>((resolve) => {
      abortAttempt = (): void => {
        const error = rootSignal.reason ?? new Error(`${name} classifier aborted`);
        controller.abort(error);
        resolve({ ok: false, error, reason: "error" });
      };
      rootSignal.addEventListener("abort", abortAttempt, { once: true });
    });

    return await Promise.race([run, timedOut, aborted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortAttempt !== undefined) rootSignal.removeEventListener("abort", abortAttempt);
  }
}

async function settleClassifierRunsExcept(
  runs: ReadonlyMap<string, Promise<SettledClassifierResult>>,
  keep: ReadonlyArray<string>,
): Promise<void> {
  const keepSet = new Set(keep);
  await Promise.all(
    [...runs].filter(([name]) => !keepSet.has(name)).map(([, run]) => run.catch(() => undefined)),
  );
}

function classifierRunStatus(settled: SettledClassifierResult) {
  if (settled.ok) return { ok: true, source: "model" as const };
  return {
    ok: false,
    source: "fallback" as const,
    reason: settled.reason,
    error: errorMessage(settled.error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
