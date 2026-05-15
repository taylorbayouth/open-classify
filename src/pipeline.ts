import { assembleResult, buildPublicOutputs } from "./aggregator.js";
import {
  MODULES_BY_NAME,
  REGISTRY,
  type RunClassifier,
} from "./classifiers.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  Catalog,
  ClassifierPublicOutputs,
  ClassifierRegistry,
  ClassifierResults,
  InspectResult,
  PipelineResult,
} from "./manifest.js";
import type {
  AppliesTo,
  Certainty,
  ClassifierOutput,
  RuntimeClassifierManifest,
} from "./stock.js";
import type {
  ClassifierFallbackReason,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;
export const DEFAULT_MAX_CONCURRENCY = 7;

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
  maxConcurrency?: number;
  signal?: AbortSignal;
}

export interface InspectOptions {
  runClassifier: RunClassifier;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
}

type SettledClassifierResult =
  | { ok: true; name: string; value: ClassifierOutput }
  | { ok: false; name: string; error: unknown; reason: ClassifierFallbackReason };

export async function classifyOpenClassifyInput(
  input: OpenClassifyInput,
  options: ClassifyOptions,
): Promise<PipelineResult> {
  const { request, results, failedClassifiers } = await runPipeline(input, "user", options);

  const reg = filteredRegistry("user");
  const assembled = assembleResult({
    registry: reg,
    results,
    failedClassifiers,
    catalog: options.catalog,
  });

  return {
    ...assembled,
    target_message_hash: request.target_message_hash,
  };
}

export async function inspectOpenClassifyInput(
  input: OpenClassifyInput,
  options: InspectOptions,
): Promise<InspectResult> {
  const { request, results } = await runPipeline(input, "assistant", options);
  const reg = filteredRegistry("assistant");

  const lastMsg = request.messages[request.messages.length - 1];

  return {
    target_message_hash: request.target_message_hash,
    message: { role: "assistant", text: lastMsg.text },
    classifier_outputs: buildPublicOutputs(reg, results),
  };
}

interface PipelineRunResult {
  readonly request: NormalizedOpenClassifyInput;
  readonly results: ClassifierResults;
  readonly failedClassifiers: ReadonlyArray<string>;
}

interface SharedPipelineOptions {
  runClassifier: RunClassifier;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
}

async function runPipeline(
  input: OpenClassifyInput,
  role: "user" | "assistant",
  options: SharedPipelineOptions,
): Promise<PipelineRunResult> {
  let request: NormalizedOpenClassifyInput;
  try {
    request = normalizeOpenClassifyInput(input, { expectedRole: role });
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
  const maxConcurrency = resolveMaxConcurrency(options.maxConcurrency);

  const registry = filteredRegistry(role);
  const queue: ReadonlyArray<string> = registry.map((m) => m.name);

  try {
    const settled = await runWithConcurrency(
      queue,
      maxConcurrency,
      controller.signal,
      (name) =>
        runClassifierWithRetry(
          name,
          classifierInput,
          options.runClassifier,
          controller.signal,
          classifierTimeoutMs,
          classifierRetryCount,
        ),
    );

    const { results, failedClassifiers } = collectResults(settled);
    return { request, results, failedClassifiers };
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

function filteredRegistry(role: "user" | "assistant"): ClassifierRegistry {
  return REGISTRY.filter((m) => roleAppliesTo(m.appliesTo, role)) as ClassifierRegistry;
}

function roleAppliesTo(appliesTo: AppliesTo, role: "user" | "assistant"): boolean {
  return appliesTo === "both" || appliesTo === role;
}

function resolveMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`maxConcurrency must be a positive integer; received ${value}`);
  }
  return Math.floor(value);
}

async function runWithConcurrency(
  names: ReadonlyArray<string>,
  maxConcurrency: number,
  signal: AbortSignal,
  start: (name: string) => Promise<SettledClassifierResult>,
): Promise<SettledClassifierResult[]> {
  const results = new Array<SettledClassifierResult>(names.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= names.length) return;
      const name = names[i];
      if (signal.aborted) {
        results[i] = {
          ok: false,
          name,
          error: signal.reason ?? new Error(`${name} classifier aborted before start`),
          reason: "error",
        };
        continue;
      }
      results[i] = await start(name);
    }
  };

  const workerCount = Math.max(1, Math.min(maxConcurrency, names.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function collectResults(settled: SettledClassifierResult[]): {
  results: ClassifierResults;
  failedClassifiers: ReadonlyArray<string>;
} {
  const results: ClassifierResults = {};
  const failedClassifiers: string[] = [];
  for (const s of settled) {
    const manifest = MODULES_BY_NAME[s.name];
    results[s.name] = s.ok ? s.value : manifest.fallback;
    if (!s.ok) failedClassifiers.push(s.name);
  }
  return { results, failedClassifiers };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
