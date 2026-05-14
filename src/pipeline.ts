import { certaintyThreshold, composeEnvelope } from "./aggregator.js";
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
  LowCertaintyBlockReason,
  PipelineMeta,
  PipelineResult,
  PromptInjectionBlockReason,
} from "./manifest.js";
import type {
  Certainty,
  ClassifierOutput,
  CustomClassifierOutputValue,
  FinalReplySignal,
  PreflightClassifierOutput,
  PromptInjectionClassifierOutput,
  PromptInjectionSignal,
} from "./stock.js";
import { certaintyScore, isCustomManifest } from "./stock.js";
import type {
  ClassifierFallbackReason,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;
export const DEFAULT_CERTAINTY_GATE = "min_score";
// Matches the typical workstation Ollama OLLAMA_NUM_PARALLEL. Surplus
// classifiers wait inside the pipeline until a slot frees, so their
// timeout budget doesn't burn while queued at the backend.
export const DEFAULT_MAX_PARALLEL = 7;

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
  // Cap on classifier requests in flight at once. Match this to the runtime
  // parallelism of your backend (e.g. Ollama's OLLAMA_NUM_PARALLEL); otherwise
  // surplus requests sit in the backend's queue while their timeout budget
  // burns. Defaults to DEFAULT_MAX_PARALLEL.
  maxParallel?: number;
  aggregator?: AggregatorConfig;
  signal?: AbortSignal;
}

// FIFO semaphore. Permit holders call release() once. Waiters are handed
// permits directly (the permit count is not incremented before resolving),
// so there is no permit/waiter race. tryAcquire exists so callers can take
// the fast path without an extra microtask hop when a permit is free.
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  tryAcquire(): boolean {
    if (this.permits <= 0) return false;
    this.permits -= 1;
    return true;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.permits += 1;
  }
}

type SettledClassifierResult =
  | { ok: true; name: string; value: ClassifierOutput }
  | { ok: false; name: string; error: unknown; reason: ClassifierFallbackReason };

// Short-circuit gates are intrinsic to specific stock signals — not configured
// per-manifest. preflight.final_reply ⇒ reply; confident high_risk or unknown
// prompt-injection risk ⇒ block. Order matters: preflight is
// cheaper to evaluate, so we check it first.
const SHORT_CIRCUIT_GATES = ["preflight", "prompt_injection"] as const;

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
  const maxParallel = resolveMaxParallel(options.maxParallel);
  const threshold = certaintyThreshold(options.aggregator);

  const limiter = new Semaphore(maxParallel);
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
        limiter,
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
    const certaintyGate = certaintyGateBlock(options.aggregator, results);
    if (certaintyGate) {
      return buildCertaintyGateBlockResult(request, envelope, results, meta, certaintyGate);
    }

    return buildRouteResult(request, envelope, results, meta);
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

type ShortCircuitVerdict =
  | { kind: "reply"; final_reply: FinalReplySignal }
  | { kind: "block"; prompt_injection: PromptInjectionSignal; reason: PromptInjectionBlockReason };

function shortCircuitVerdict(
  gate: (typeof SHORT_CIRCUIT_GATES)[number],
  result: ClassifierOutput,
  threshold: number,
): ShortCircuitVerdict | null {
  const score = scoreCertainty(result.certainty);
  if (score < threshold) return null;

  if (gate === "preflight") {
    const preflight = result as PreflightClassifierOutput;
    if (preflight.final_reply !== undefined) {
      return { kind: "reply", final_reply: preflight.final_reply };
    }
    return null;
  }

  if (gate === "prompt_injection") {
    const promptInjection = result as PromptInjectionClassifierOutput;
    if (promptInjection.risk_level === "high_risk" || promptInjection.risk_level === "unknown") {
      const promptInjectionSignal = extractPromptInjection(promptInjection);
      return {
        kind: "block",
        prompt_injection: promptInjectionSignal,
        reason: {
          kind: "prompt_injection",
          risk_level: promptInjectionSignal.risk_level,
        },
      };
    }
  }

  return null;
}

function certaintyGateBlock(
  config: AggregatorConfig | undefined,
  results: ClassifierResults,
): LowCertaintyBlockReason | undefined {
  const mode = config?.certaintyGate ?? DEFAULT_CERTAINTY_GATE;
  if (mode === "off") return undefined;

  const threshold = certaintyThreshold(config);
  const classifier_scores = classifierScores(results);
  const scores = Object.values(classifier_scores);
  const score = mode === "min_score"
    ? Math.min(...scores)
    : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  if (score >= threshold) return undefined;

  return {
    kind: "low_certainty",
    mode,
    threshold,
    score,
    classifier_scores,
    low_classifiers: Object.entries(classifier_scores)
      .filter(([, value]) => value < threshold)
      .map(([name]) => name),
  };
}

function classifierScores(results: ClassifierResults): Record<string, number> {
  return Object.fromEntries(
    REGISTRY.map((manifest) => [
      manifest.name,
      scoreCertainty(results[manifest.name]?.certainty),
    ]),
  );
}

function scoreCertainty(certainty: Certainty | undefined): number {
  return certainty === undefined ? 0 : certaintyScore[certainty];
}

function extractPromptInjection(value: PromptInjectionClassifierOutput): PromptInjectionSignal {
  return {
    risk_level: value.risk_level,
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

  if (verdict.kind === "reply") {
    const preflight = value as PreflightClassifierOutput;
    return {
      action: "reply",
      message_id: target_message_hash,
      reply: { text: verdict.final_reply.reply },
      reason: "preflight_reply",
      classifier_outputs,
      audit: {
        fired_by: name,
        ...(preflight.final_reply === undefined ? {} : { final_reply: preflight.final_reply }),
        meta,
      },
    };
  }
  return {
    action: "block",
    message_id: target_message_hash,
    fired_by: name,
    reason: verdict.reason,
    classifier_outputs,
    audit: {
      fired_by: name,
      prompt_injection: verdict.prompt_injection,
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
    target_message: {
      role: "user",
      text: request.text,
      hash: request.target_message_hash,
    },
    tools: envelope.tools ?? { tools: [] },
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

function buildCertaintyGateBlockResult(
  request: NormalizedOpenClassifyInput,
  envelope: Envelope,
  results: ClassifierResults,
  meta: PipelineMeta,
  certaintyGate: LowCertaintyBlockReason,
): PipelineResult {
  return {
    action: "block",
    message_id: request.target_message_hash,
    fired_by: "certainty_gate",
    reason: certaintyGate,
    classifier_outputs: classifierCustomOutputs(results),
    audit: {
      ...envelope,
      fired_by: "certainty_gate",
      certainty_gate: certaintyGate,
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
  limiter: Semaphore,
): Promise<SettledClassifierResult> {
  let lastError: unknown = new Error(`${name} classifier did not run`);
  let lastReason: ClassifierFallbackReason = "error";

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (rootSignal.aborted) break;
    // Acquire before invoking the attempt so the timeout budget only starts
    // counting once we actually hand the request to the backend. Take the
    // synchronous fast path when a permit is free so dispatch order matches
    // the unconstrained case for callers that abort right after kickoff.
    if (!limiter.tryAcquire()) {
      await limiter.acquire();
      if (rootSignal.aborted) {
        limiter.release();
        break;
      }
    }
    try {
      const result = await runClassifierAttempt(name, input, runClassifier, rootSignal, timeoutMs);
      if (result.ok) return { ok: true, name, value: result.value };
      lastError = result.error;
      lastReason = result.reason;
    } finally {
      limiter.release();
    }
  }

  return { ok: false, name, error: lastError, reason: lastReason };
}

function resolveMaxParallel(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `maxParallel must be a positive integer, received ${String(value)}`,
    );
  }
  return value;
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
