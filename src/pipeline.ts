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
  ClassifierResults,
  PipelineMeta,
  PipelineResult,
} from "./manifest.js";
import type { HandoffSignal, SafetySignal, StockClassifierOutput } from "./stock.js";
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
  | { ok: true; name: string; value: StockClassifierOutput }
  | { ok: false; name: string; error: unknown; reason: ClassifierFallbackReason };

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
    const gates = REGISTRY
      .filter((m) => m.short_circuit !== undefined)
      .slice()
      .sort((a, b) => a.short_circuit!.priority - b.short_circuit!.priority);

    for (const manifest of gates) {
      const settled = await runs.get(manifest.name)!;
      if (!settled.ok) continue;
      const verdict = shortCircuitVerdict(manifest, settled.value, options.aggregator);
      if (!verdict) continue;

      controller.abort();
      await settleClassifierRunsExcept(runs, [manifest.name]);
      return buildShortCircuitResult(
        manifest.name,
        verdict,
        settled,
        request.target_message_hash,
      );
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

    return {
      decision: "route",
      target_message_hash: request.target_message_hash,
      meta,
      ...envelope,
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

function shortCircuitVerdict(
  manifest: (typeof REGISTRY)[number],
  result: StockClassifierOutput,
  config: AggregatorConfig | undefined,
): ({ kind: "final"; reply: string } | { kind: "block" }) | null {
  const threshold = config?.confidenceThreshold ?? 0.6;
  const handoff = result.handoff;
  if (!manifest.short_circuit || !handoff || result.confidence < threshold) return null;
  if (!manifest.short_circuit.kinds.includes(handoff.kind)) return null;
  if (handoff.kind === "final") return { kind: "final", reply: handoff.reply };
  if (handoff.kind === "block") return { kind: "block" };
  return null;
}

function buildShortCircuitResult(
  name: string,
  verdict: { kind: "final"; reply: string } | { kind: "block" },
  settled: SettledClassifierResult,
  target_message_hash: string,
): PipelineResult {
  const manifest = MODULES_BY_NAME[name];
  const value = settled.ok ? settled.value : manifest.fallback;
  const entry: ClassifierEntry = {
    ...value,
    status: classifierRunStatus(settled),
    version: manifest.version,
  };
  return {
    decision: "short_circuit",
    target_message_hash,
    fired_by: name,
    ...shortCircuitStockSignals(value),
    meta: { classifiers: { [name]: entry } },
    ...verdict,
  };
}

function shortCircuitStockSignals(
  value: StockClassifierOutput,
): { handoff?: HandoffSignal; safety?: SafetySignal } {
  return {
    ...(value.handoff === undefined ? {} : { handoff: value.handoff }),
    ...(value.safety === undefined ? {} : { safety: value.safety }),
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
    };
  }
  return { results, meta: { classifiers } };
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
  | { ok: true; value: StockClassifierOutput }
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
  await Promise.all([...runs].filter(([name]) => !keepSet.has(name)).map(([, run]) => run.catch(() => undefined)));
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
