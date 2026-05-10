// The orchestration layer. Given a `RunClassifier` (e.g. the Ollama runner),
// this module:
//   1. Normalizes input.
//   2. Kicks off every registered classifier in parallel with timeout + retry.
//   3. Awaits each module with a `shortCircuit` in priority order. If any
//      returns a verdict, aborts the rest and emits a `short_circuit` envelope.
//   4. Otherwise waits for every run to settle, composes the route envelope
//      via `composeEnvelope`, and returns it.
//
// Two design choices worth flagging:
// - All classifiers start at the same time. Sequential short-circuit checks
//   would be cheaper on the happy path but slower in the common case. We pay
//   for everything upfront and just throw away work on early exit.
// - Any classifier that errors or times out falls back to a conservative
//   default (its module's `fallback`, which must carry `confidence: 0`). The
//   pipeline never throws from a single classifier failure — only
//   normalization, missing catalog (on route), or envelope composition can.

import {
  CLASSIFIERS,
  REGISTRY,
  type Registry,
} from "./classifiers.js";
import { composeEnvelope } from "./aggregator.js";
import { PREFLIGHT_FALLBACK } from "./classifiers/preflight/result.js";
import { ROUTING_FALLBACK } from "./classifiers/routing/result.js";
import { CONVERSATION_HISTORY_FALLBACK } from "./classifiers/conversation_history/result.js";
import { MEMORY_RETRIEVAL_QUERIES_FALLBACK } from "./classifiers/memory_retrieval_queries/result.js";
import { TOOLS_FALLBACK } from "./classifiers/tools/result.js";
import { MODEL_SPECIALIZATION_FALLBACK } from "./classifiers/model_specialization/result.js";
import { SECURITY_FALLBACK } from "./classifiers/security/result.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  AggregatorConfig,
  AnyClassifierModule,
  Catalog,
  ClassifierResultBase,
  ClassifierResultsMap,
  FullClassifierEntriesOf,
  PartialClassifierEntriesOf,
  PipelineResult,
  ShortCircuitVerdict,
} from "./manifest.js";
import type {
  ClassifierEntry,
  ClassifierFallbackReason,
  ClassifierName,
  ClassifierOutput,
  ClassifierRunStatus,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
  RunClassifier,
} from "./types.js";

// Thrown when the input is structurally invalid (bad shape, oversized
// message, etc.). This is the only error `classifyOpenClassifyInput` will
// throw — classifier failures are absorbed into fallback outputs.
export class OpenClassifyNormalizationError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "OpenClassifyNormalizationError";
  }
}

export interface ClassifyOptions extends AggregatorConfig {
  runClassifier: RunClassifier;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  // Required for the route path so the model resolver has metadata to read.
  // Short-circuit paths don't use it. If omitted and the pipeline reaches the
  // route path, the pipeline throws.
  catalog?: Catalog;
  signal?: AbortSignal;
}

// Re-export for consumers that prefer to import the pipeline output type from
// the orchestrator module. The shape itself lives in manifest.ts.
export type OpenClassifyPipelineResult = PipelineResult<Registry>;

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;

// Reference catalog showing how to populate `downstream-models.json`. Not
// used by the pipeline by default — callers pass their own via `catalog`.
export const EXAMPLE_CATALOG: Catalog = {
  models: [
    {
      id: "gpt-5.5",
      specializations: [
        "reasoning",
        "coding",
        "writing",
        "planning",
        "chat",
        "instruction_following",
      ],
      execution_modes: ["direct", "tool_assisted", "workflow"],
      tiers: ["frontier_strong"],
      params_in_millions: 800_000,
      context_window: 1_000_000,
    },
    {
      id: "gpt-5.4-mini",
      specializations: ["chat", "writing"],
      execution_modes: ["direct"],
      tiers: ["frontier_fast"],
      params_in_millions: 15_000,
      context_window: 200_000,
    },
    {
      id: "gpt-5.3-codex",
      specializations: ["coding"],
      execution_modes: ["direct", "tool_assisted"],
      tiers: ["frontier_fast"],
      params_in_millions: 30_000,
      context_window: 500_000,
    },
    {
      id: "qwen2.5-coder:14b",
      specializations: ["coding"],
      execution_modes: ["direct", "tool_assisted"],
      tiers: ["local_strong"],
      params_in_millions: 14_000,
      context_window: 128_000,
    },
    {
      id: "gemma4:e4b-it-q4_K_M",
      specializations: ["chat", "reasoning", "planning", "instruction_following"],
      execution_modes: ["direct"],
      tiers: ["local_fast", "local_strong"],
      params_in_millions: 4_000,
      context_window: 8192,
    },
  ],
  default: "gpt-5.4-mini",
};

type SettledClassifierResult<Name extends ClassifierName> =
  | {
      ok: true;
      name: Name;
      value: ClassifierOutput<Name>;
    }
  | {
      ok: false;
      name: Name;
      error: unknown;
      reason: ClassifierFallbackReason;
    };

// Typed as a mapped object so each entry is checked against its own output
// shape — no casts needed when indexing by a generic `Name`.
const FALLBACK_OUTPUTS: { [Name in ClassifierName]: ClassifierOutput<Name> } = {
  preflight: PREFLIGHT_FALLBACK,
  routing: ROUTING_FALLBACK,
  conversation_history: CONVERSATION_HISTORY_FALLBACK,
  memory_retrieval_queries: MEMORY_RETRIEVAL_QUERIES_FALLBACK,
  tools: TOOLS_FALLBACK,
  model_specialization: MODEL_SPECIALIZATION_FALLBACK,
  security: SECURITY_FALLBACK,
};

export async function classifyOpenClassifyInput(
  input: OpenClassifyInput,
  options: ClassifyOptions,
): Promise<OpenClassifyPipelineResult> {
  let request: NormalizedOpenClassifyInput;
  try {
    request = normalizeOpenClassifyInput(input);
  } catch (error) {
    throw new OpenClassifyNormalizationError(error);
  }

  // Single shared abort signal: when any classifier's shortCircuit fires, we
  // abort the rest of the in-flight runs so we don't pay for work nobody will
  // read.
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
  const runs = new Map<ClassifierName, Promise<SettledClassifierResult<ClassifierName>>>(
    REGISTRY.map((module_) => [
      module_.name,
      runClassifierWithRetry(
        module_.name,
        classifierInput,
        options.runClassifier,
        controller.signal,
        classifierTimeoutMs,
        classifierRetryCount,
      ),
    ]),
  );

  try {
    // ─── Generic short-circuit loop ──────────────────────────────────────
    // Iterate modules with shortCircuit in priority order (ascending).
    // Await each. If a verdict comes back, abort the rest and emit a
    // short_circuit envelope. The `finishedSoFar` set tracks which modules
    // have settled before the firing one — they're the only ones included in
    // `meta.classifiers` on the short_circuit envelope.
    const shortCircuiters = (REGISTRY as ReadonlyArray<AnyClassifierModule>)
      .filter((m) => m.shortCircuit !== undefined)
      .slice()
      .sort(
        (a, b) =>
          (a.shortCircuit?.priority ?? 0) - (b.shortCircuit?.priority ?? 0),
      );

    const finishedSoFar = new Set<ClassifierName>();

    for (const module_ of shortCircuiters) {
      const name = module_.name as ClassifierName;
      const settled = (await runs.get(name)) as SettledClassifierResult<typeof name>;
      finishedSoFar.add(name);

      // Never honor a verdict from a fallback. A failed classifier should not
      // short-circuit the pipeline — return-to-route is the conservative call.
      if (!settled.ok) continue;

      const verdict = module_.shortCircuit?.evaluate(
        settled.value as ClassifierResultBase,
      );
      if (!verdict) continue;

      controller.abort();
      await settleClassifierRunsExcept(runs, [...finishedSoFar]);

      return await buildShortCircuitResult(
        request.target_message_hash,
        name,
        verdict,
        runs,
        finishedSoFar,
      );
    }

    // ─── Route path ──────────────────────────────────────────────────────
    if (options.catalog === undefined) {
      throw new Error(
        "classifyOpenClassifyInput: `catalog` is required on the route path; " +
          "no module short-circuited and the model resolver needs a catalog. " +
          "Pass `EXAMPLE_CATALOG` for examples or load yours via `loadCatalog`.",
      );
    }

    const settled = await Promise.all([...runs.values()]);
    const settledByName = new Map<ClassifierName, SettledClassifierResult<ClassifierName>>(
      settled.map((s) => [s.name, s]),
    );

    const results: Record<string, ClassifierResultBase> = {};
    const entries: Record<string, ClassifierEntry<ClassifierName> & { version: string }> = {};
    for (const module_ of REGISTRY) {
      const name = module_.name as ClassifierName;
      const s = settledByName.get(name)!;
      const status = classifierRunStatus(s);
      const value = s.ok ? s.value : FALLBACK_OUTPUTS[name];
      results[name] = value as ClassifierResultBase;
      entries[name] = {
        ...(value as object),
        status,
        version: module_.version,
      } as ClassifierEntry<typeof name> & { version: string };
    }

    const envelope = composeEnvelope({
      registry: REGISTRY,
      results: results as ClassifierResultsMap<Registry>,
      catalog: options.catalog,
      input: classifierInput,
      config: {
        confidenceThreshold: options.confidenceThreshold,
        mergeOverrides: options.mergeOverrides,
      },
    });

    return {
      decision: "route",
      target_message_hash: request.target_message_hash,
      ...envelope,
      meta: {
        classifiers: entries as unknown as FullClassifierEntriesOf<Registry>,
      },
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromOptions);
  }
}

// Build the short_circuit envelope. Pulls already-settled entries for the
// modules that finished before the firing one (always includes `firedBy`).
async function buildShortCircuitResult(
  target_message_hash: string,
  firedBy: ClassifierName,
  verdict: ShortCircuitVerdict,
  runs: ReadonlyMap<ClassifierName, Promise<SettledClassifierResult<ClassifierName>>>,
  finishedSoFar: ReadonlySet<ClassifierName>,
): Promise<OpenClassifyPipelineResult> {
  const partialEntries: Record<string, ClassifierEntry<ClassifierName> & { version: string }> = {};
  for (const name of finishedSoFar) {
    const run = runs.get(name);
    if (!run) continue;
    const s = await run;
    const status = classifierRunStatus(s);
    const value = s.ok ? s.value : FALLBACK_OUTPUTS[name];
    const module_ = CLASSIFIERS[name];
    partialEntries[name] = {
      ...(value as object),
      status,
      version: module_.version,
    } as ClassifierEntry<typeof name> & { version: string };
  }

  const meta = {
    classifiers: partialEntries as unknown as PartialClassifierEntriesOf<Registry>,
  };

  if (verdict.kind === "block") {
    return {
      decision: "short_circuit",
      target_message_hash,
      fired_by: firedBy,
      kind: "block",
      meta,
    };
  }
  return {
    decision: "short_circuit",
    target_message_hash,
    fired_by: firedBy,
    kind: verdict.kind,
    reply: verdict.reply,
    meta,
  };
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

    const result = await runClassifierAttempt(
      name,
      input,
      runClassifier,
      rootSignal,
      timeoutMs,
    );

    if (result.ok) {
      return {
        ok: true,
        name,
        value: result.value,
      };
    }

    lastError = result.error;
    lastReason = result.reason;
  }

  return {
    ok: false,
    name,
    error: lastError,
    reason: lastReason,
  };
}

// A single attempt: races the classifier against a timeout AND a root-abort
// signal. Whichever resolves first wins. The local AbortController lets us
// cancel the underlying fetch when timeout/abort wins so we don't keep the
// HTTP request alive for nothing.
async function runClassifierAttempt<Name extends ClassifierName>(
  name: Name,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
): Promise<
  | { ok: true; value: ClassifierOutput<Name> }
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
        resolve({
          ok: false,
          error: timeoutError,
          reason: "timeout",
        });
      }, timeoutMs);
    });
    const aborted = new Promise<{ ok: false; error: unknown; reason: "error" }>((resolve) => {
      abortAttempt = (): void => {
        const error = rootSignal.reason ?? new Error(`${name} classifier aborted`);
        controller.abort(error);
        resolve({
          ok: false,
          error,
          reason: "error",
        });
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
  runs: ReadonlyMap<ClassifierName, Promise<SettledClassifierResult<ClassifierName>>>,
  excludedNames: ClassifierName[],
): Promise<void> {
  const excluded = new Set(excludedNames);
  await Promise.all(
    [...runs]
      .filter(([name]) => !excluded.has(name))
      .map(([, run]) => run),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function classifierRunStatus(
  settled: SettledClassifierResult<ClassifierName>,
): ClassifierRunStatus {
  if (settled.ok) {
    return {
      ok: true,
      source: "model",
    };
  }

  return {
    ok: false,
    source: "fallback",
    reason: settled.reason,
    error: errorMessage(settled.error),
  };
}
