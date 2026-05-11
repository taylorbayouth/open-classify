// Pipeline orchestration. Generic over the registry: nothing in this file
// knows the identity of any specific classifier. The flow is:
//
//   1. Normalize input.
//   2. Kick off every registered classifier in parallel with timeout + retry.
//   3. Walk short-circuit-capable modules in priority order. As each one
//      settles, evaluate its `shortCircuit.evaluate` — if it returns a
//      verdict from a real (non-fallback) result, abort the rest and emit
//      a `short_circuit` pipeline result.
//   4. Otherwise wait for everything to settle and emit a `route` pipeline
//      result with the envelope assembled by `composeEnvelope`.
//
// Design notes worth flagging:
// - All classifiers start at the same time. Sequential gates would be cheaper
//   on the happy path but slower in the common case. We pay for everything
//   upfront and throw away work on early exit.
// - Any classifier that errors or times out falls back to its module's
//   conservative default (with `confidence: 0`). The pipeline never throws
//   from a single classifier failure — only normalization throws.

import { composeEnvelope } from "./aggregator.js";
import {
  CLASSIFIER_NAMES,
  MODULES_BY_NAME,
  REGISTRY,
  type ClassifierName,
  type ClassifierResults,
  type RegistryType,
  type RunClassifier,
} from "./classifiers.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  AggregatorConfig,
  AnyClassifierModule,
  Catalog,
  ClassifierResultBase,
  ClassifierResultsMap,
  Envelope,
  FullClassifierEntriesOf,
  PartialClassifierEntriesOf,
  PipelineResult,
  ShortCircuitVerdict,
} from "./manifest.js";
import type {
  ClassifierFallbackReason,
  ClassifierRunStatus,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;

// Thrown when the input is structurally invalid (bad shape, oversized
// message, etc.). This is the only error `classifyOpenClassifyInput` will
// throw — classifier failures are absorbed into fallback outputs.
export class OpenClassifyNormalizationError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "OpenClassifyNormalizationError";
  }
}

export interface ClassifyOptions {
  runClassifier: RunClassifier;
  // Required: callers must supply a validated `Catalog` (load with
  // `loadCatalog` or hand-build). The aggregator's resolver always emits a
  // `model_recommendation` on the route path, even when no constraints
  // match — it falls back to `catalog.default`.
  catalog: Catalog;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  aggregator?: AggregatorConfig;
  signal?: AbortSignal;
}

type SettledClassifierResult<Name extends ClassifierName> =
  | {
      ok: true;
      name: Name;
      value: ClassifierResults[Name];
    }
  | {
      ok: false;
      name: Name;
      error: unknown;
      reason: ClassifierFallbackReason;
    };

type AnySettled = SettledClassifierResult<ClassifierName>;

export async function classifyOpenClassifyInput(
  input: OpenClassifyInput,
  options: ClassifyOptions,
): Promise<PipelineResult<RegistryType>> {
  let request: NormalizedOpenClassifyInput;
  try {
    request = normalizeOpenClassifyInput(input);
  } catch (error) {
    throw new OpenClassifyNormalizationError(error);
  }

  // Single shared abort signal: when any short-circuit fires, we abort the
  // remaining in-flight runs so we don't pay for work nobody will read.
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
  const classifierTimeoutMs =
    options.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const classifierRetryCount =
    options.classifierRetryCount ?? DEFAULT_CLASSIFIER_RETRY_COUNT;

  const runs = new Map<ClassifierName, Promise<AnySettled>>(
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
    // Walk short-circuit-capable modules in priority order. A real verdict
    // wins; a fallback never fires the gate (defensive: a model crash
    // shouldn't terminate the conversation or block the user).
    const gates: AnyClassifierModule[] = (REGISTRY as ReadonlyArray<AnyClassifierModule>)
      .filter((m) => m.shortCircuit !== undefined)
      .slice()
      .sort((a, b) => a.shortCircuit!.priority - b.shortCircuit!.priority);

    for (const module_ of gates) {
      const settled = await runs.get(module_.name as ClassifierName)!;
      if (!settled.ok) continue;
      const verdict = module_.shortCircuit!.evaluate(settled.value);
      if (!verdict) continue;

      controller.abort();
      await settleClassifierRunsExcept(runs, [module_.name as ClassifierName]);

      return buildShortCircuitResult(
        module_.name as ClassifierName,
        verdict,
        settled,
        request.target_message_hash,
      );
    }

    const settled = await Promise.all([...runs.values()]);
    const { results, entries } = collectFullEntries(settled);

    const envelope = composeEnvelope({
      registry: REGISTRY,
      results,
      catalog: options.catalog,
      input: classifierInput,
      config: options.aggregator,
    });

    return buildRouteResult(request.target_message_hash, entries, envelope);
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

function buildShortCircuitResult(
  name: ClassifierName,
  verdict: ShortCircuitVerdict,
  settled: AnySettled,
  target_message_hash: string,
): PipelineResult<RegistryType> {
  const module_ = MODULES_BY_NAME[name];
  const value = settled.ok ? (settled.value as ClassifierResultBase) : module_.fallback;
  const entry = {
    ...value,
    status: classifierRunStatus(settled),
    version: module_.version,
  };
  const meta = {
    classifiers: { [name]: entry } as PartialClassifierEntriesOf<RegistryType>,
  };
  return {
    decision: "short_circuit",
    target_message_hash,
    fired_by: name,
    meta,
    ...verdict,
  };
}

function buildRouteResult(
  target_message_hash: string,
  entries: FullClassifierEntriesOf<RegistryType>,
  envelope: Envelope,
): PipelineResult<RegistryType> {
  return {
    decision: "route",
    target_message_hash,
    meta: { classifiers: entries },
    ...envelope,
  };
}

// Build the full classifier-results map and the meta-entries map from the
// settled runs. Each entry is the verdict value (or fallback) merged with
// `status` and `version`.
function collectFullEntries(settled: AnySettled[]): {
  results: ClassifierResults;
  entries: FullClassifierEntriesOf<RegistryType>;
} {
  const results = {} as ClassifierResults;
  const entries = {} as FullClassifierEntriesOf<RegistryType>;
  for (const s of settled) {
    const module_ = MODULES_BY_NAME[s.name];
    const value = s.ok ? s.value : (module_.fallback as ClassifierResults[ClassifierName]);
    (results as Record<string, ClassifierResultBase>)[s.name] = value;
    (entries as Record<string, unknown>)[s.name] = {
      ...value,
      status: classifierRunStatus(s),
      version: module_.version,
    };
  }
  return { results, entries };
}

// One classifier, with bounded retries. Stops early if the root signal has
// already been aborted — no point retrying once the pipeline has decided.
async function runClassifierWithRetry<Name extends ClassifierName>(
  name: Name,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
  retryCount: number,
): Promise<SettledClassifierResult<Name>> {
  let lastError: unknown = new Error(`${name} classifier did not run`);
  let lastReason: ClassifierFallbackReason = "error";

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (rootSignal.aborted) {
      break;
    }

    const result = await runClassifierAttempt(name, input, runClassifier, rootSignal, timeoutMs);

    if (result.ok) {
      return { ok: true, name, value: result.value };
    }

    lastError = result.error;
    lastReason = result.reason;
  }

  return { ok: false, name, error: lastError, reason: lastReason };
}

// A single attempt: races the classifier against a timeout AND the root
// abort signal. Whichever resolves first wins. The local AbortController
// lets us cancel the underlying fetch when timeout/abort wins so we don't
// keep the HTTP request alive for nothing.
async function runClassifierAttempt<Name extends ClassifierName>(
  name: Name,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
): Promise<
  | { ok: true; value: ClassifierResults[Name] }
  | { ok: false; error: unknown; reason: ClassifierFallbackReason }
> {
  const controller = new AbortController();
  const timeoutError = new Error(`${name} classifier timed out after ${timeoutMs}ms`);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortAttempt: (() => void) | undefined;

  try {
    const run = runClassifier(name, input, controller.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error,
        reason: "error" as const,
      }),
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
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (abortAttempt !== undefined) {
      rootSignal.removeEventListener("abort", abortAttempt);
    }
  }
}

async function settleClassifierRunsExcept(
  runs: ReadonlyMap<ClassifierName, Promise<AnySettled>>,
  excludedNames: ClassifierName[],
): Promise<void> {
  const excluded = new Set(excludedNames);
  await Promise.all(
    [...runs]
      .filter(([name]) => !excluded.has(name))
      .map(([, run]) => run),
  );
}

function classifierRunStatus(settled: AnySettled): ClassifierRunStatus {
  if (settled.ok) {
    return { ok: true, source: "model" };
  }
  return {
    ok: false,
    source: "fallback",
    reason: settled.reason,
    error: errorMessage(settled.error),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Re-export the generic `ClassifierResultsMap` indirection some consumers
// (e.g. custom backends) may want. The concrete `ClassifierResults` lives
// in `classifiers.ts`.
export type { ClassifierResultsMap };
