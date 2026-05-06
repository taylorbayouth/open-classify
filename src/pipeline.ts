import { CLASSIFIER_NAMES } from "./classifiers.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  ClassifierFallbackReason,
  ClassifierName,
  ClassifierOutput,
  ClassifierRunStatus,
  ClassifierRunStatusMap,
  DownstreamModelConfig,
  DownstreamModelConfigKey,
  ModelSpecializationResult,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
  OpenClassifyHandoff,
  OpenClassifyPipelineResult,
  OpenClassifyResult,
  PreflightResult,
  RoutingResult,
  RunClassifier,
} from "./types.js";

export class OpenClassifyNormalizationError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "OpenClassifyNormalizationError";
  }
}

export interface ClassifyOptions {
  runClassifier: RunClassifier;
  classifierTimeoutMs?: number;
  classifierRetryCount?: number;
  downstreamModels?: DownstreamModelConfig;
}

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 15_000;
export const DEFAULT_CLASSIFIER_RETRY_COUNT = 1;
export const EXAMPLE_DOWNSTREAM_MODEL_CONFIG = {
  "chat.local_fast": "gemma4:e4b-it-q4_K_M",
  "writing.frontier_fast": "gpt-5.4-mini",
  "reasoning.local_strong": "gemma4:e4b-it-q4_K_M",
  "reasoning.frontier_strong": "gpt-5.5",
  "planning.local_strong": "gemma4:e4b-it-q4_K_M",
  "coding.local_strong": "qwen2.5-coder:14b",
  "coding.frontier_fast": "gpt-5.3-codex",
  "instruction_following.local_fast": "gemma4:e4b-it-q4_K_M",
  local_fast: "gemma4:e4b-it-q4_K_M",
  local_strong: "gemma4:e4b-it-q4_K_M",
  frontier_fast: "gpt-5.4-mini",
  frontier_strong: "gpt-5.5",
  default: "gpt-5.4-mini",
} as const satisfies DownstreamModelConfig;
const SECURITY_BLOCK_REPLY = "I can't help with that request.";

type SettledClassifierResult<Name extends ClassifierName> =
  | {
      ok: true;
      name: Name;
      value: ClassifierOutput<Name>;
      attempts: number;
    }
  | {
      ok: false;
      name: Name;
      error: unknown;
      reason: ClassifierFallbackReason;
      attempts: number;
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

  const controller = new AbortController();
  const classifierInput = toClassifierInput(request);
  const classifierTimeoutMs =
    options.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const classifierRetryCount =
    options.classifierRetryCount ?? DEFAULT_CLASSIFIER_RETRY_COUNT;
  const runs = new Map(
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

  const preflightSettled = await (runs.get("preflight") as Promise<SettledClassifierResult<"preflight">>);
  const preflight = preflightSettled.ok
    ? preflightSettled.value
    : fallbackClassifierOutput("preflight");

  if (preflightSettled.ok && preflight.terminality === "terminal") {
    controller.abort();
    await settleClassifierRunsExcept(runs, ["preflight"]);

    return {
      stop_downstream: true,
      decision: "terminal",
      target_message_hash: request.target_message_hash,
      reply: preflight.reply,
      preflight,
      classifier_status: {
        preflight: classifierRunStatus(preflightSettled),
      },
    };
  }

  const securitySettled = await (runs.get("security") as Promise<
    SettledClassifierResult<"security">
  >);
  const security = securitySettled.ok
    ? securitySettled.value
    : fallbackClassifierOutput("security");

  if (securitySettled.ok && security.risk_level === "high_risk") {
    controller.abort();
    await settleClassifierRunsExcept(runs, ["preflight", "security"]);

    return {
      stop_downstream: true,
      decision: "block",
      target_message_hash: request.target_message_hash,
      reply: SECURITY_BLOCK_REPLY,
      preflight,
      security,
      classifier_status: {
        preflight: classifierRunStatus(preflightSettled),
        security: classifierRunStatus(securitySettled),
      },
    };
  }

  const settled = await Promise.all(
    CLASSIFIER_NAMES.map((name) => runs.get(name)!),
  );

  const results = new Map(settled.map((entry) => [entry.name, entry]));

  const classifiers: OpenClassifyResult = {
    preflight: resultOrFallback(results, "preflight"),
    routing: resultOrFallback(results, "routing"),
    conversation_history: resultOrFallback(results, "conversation_history"),
    memory_retrieval_queries: resultOrFallback(results, "memory_retrieval_queries"),
    tools: resultOrFallback(results, "tools"),
    model_specialization: resultOrFallback(results, "model_specialization"),
    security: resultOrFallback(results, "security"),
  };

  return {
    stop_downstream: false,
    decision: "route",
    target_message_hash: request.target_message_hash,
    reply: classifiers.preflight.reply,
    handoff: buildHandoff(classifiers, options.downstreamModels),
    classifiers,
    classifier_status: classifierRunStatuses(settled),
  };
}

export function buildHandoff(
  classifiers: OpenClassifyResult,
  downstreamModels: DownstreamModelConfig = {},
): OpenClassifyHandoff {
  return {
    execution_mode: classifiers.routing.execution_mode,
    model: resolveDownstreamModel(
      classifiers.routing,
      classifiers.model_specialization,
      downstreamModels,
    ),
    context: {
      conversation: {
        prior_messages_needed:
          classifiers.conversation_history.relevant_conversation_history.length,
        messages: classifiers.conversation_history.relevant_conversation_history,
        needs_unseen_history: classifiers.conversation_history.needs_unseen_history,
      },
      memory: {
        queries: classifiers.memory_retrieval_queries.queries,
      },
      tools: {
        needed: classifiers.tools.needed,
        families: classifiers.tools.families,
      },
    },
    safety: {
      risk_level: classifiers.security.risk_level,
      signals: classifiers.security.signals,
    },
  };
}

function resolveDownstreamModel(
  routing: RoutingResult,
  specialization: ModelSpecializationResult,
  downstreamModels: DownstreamModelConfig,
): OpenClassifyHandoff["model"] {
  const candidates = downstreamModelConfigKeys(
    specialization.model_specialization,
    routing.model_tier,
  );
  const resolvedFrom =
    candidates.find((key) => modelValue(downstreamModels, key) !== null) ?? null;

  return {
    key: candidates[0],
    model: resolvedFrom ? modelValue(downstreamModels, resolvedFrom) : null,
    resolved_from: resolvedFrom,
    tier: routing.model_tier,
    specialization: specialization.model_specialization,
  };
}

function downstreamModelConfigKeys(
  specialization: ModelSpecializationResult["model_specialization"],
  tier: RoutingResult["model_tier"],
): DownstreamModelConfigKey[] {
  const keys: DownstreamModelConfigKey[] = [];
  const hasSpecialization = specialization !== "unclear";
  const hasTier = tier !== "unable_to_determine";

  if (hasSpecialization && hasTier) {
    keys.push(`${specialization}.${tier}` as DownstreamModelConfigKey);
  }
  if (hasTier) {
    keys.push(tier);
  }
  if (hasSpecialization) {
    keys.push(specialization);
  }
  keys.push("default");

  return keys;
}

function modelValue(
  downstreamModels: DownstreamModelConfig,
  key: DownstreamModelConfigKey,
): string | null {
  const value = downstreamModels[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function runClassifierWithRetry<Name extends ClassifierName>(
  name: Name,
  input: Parameters<RunClassifier>[1],
  runClassifier: RunClassifier,
  rootSignal: AbortSignal,
  timeoutMs: number,
  retryCount: number,
): Promise<SettledClassifierResult<Name>> {
  let attempts = 0;
  let lastError: unknown = new Error(`${name} classifier did not run`);
  let lastReason: ClassifierFallbackReason = "error";

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (rootSignal.aborted) {
      break;
    }

    attempts += 1;
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
        attempts,
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
    attempts,
  };
}

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

function resultOrFallback<Name extends ClassifierName>(
  results: ReadonlyMap<ClassifierName, SettledClassifierResult<ClassifierName>>,
  name: Name,
): ClassifierOutput<Name> {
  const settled = results.get(name);
  if (settled?.ok) {
    return settled.value as ClassifierOutput<Name>;
  }

  return fallbackClassifierOutput(name);
}

function classifierRunStatuses(
  settled: SettledClassifierResult<ClassifierName>[],
): ClassifierRunStatusMap {
  return Object.fromEntries(
    settled.map((entry) => [entry.name, classifierRunStatus(entry)]),
  ) as ClassifierRunStatusMap;
}

function classifierRunStatus(
  settled: SettledClassifierResult<ClassifierName>,
): ClassifierRunStatus {
  if (settled.ok) {
    return {
      ok: true,
      source: "model",
      attempts: settled.attempts,
    };
  }

  return {
    ok: false,
    source: "fallback",
    attempts: settled.attempts,
    reason: settled.reason,
    error: errorMessage(settled.error),
  };
}

function fallbackClassifierOutput<Name extends ClassifierName>(
  name: Name,
): ClassifierOutput<Name> {
  switch (name) {
    case "preflight":
      return {
        terminality: "unable_to_determine",
        reply: "Let me check.",
        reason: "Preflight classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "routing":
      return {
        execution_mode: "direct",
        model_tier: "local_strong",
        reason: "Routing classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "conversation_history":
      return {
        is_standalone: false,
        refers_to_history: false,
        relevant_conversation_history: [],
        needs_unseen_history: true,
        reason: "Conversation history classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "memory_retrieval_queries":
      return {
        queries: [],
        reason: "Memory retrieval query classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "tools":
      return {
        needed: false,
        families: [],
        reason: "Tool classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "model_specialization":
      return {
        model_specialization: "unclear",
        reason: "Model specialization classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
    case "security":
      return {
        risk_level: "unable_to_determine",
        signals: [],
        reason: "Security classifier unavailable.",
      } as unknown as ClassifierOutput<Name>;
  }
}
