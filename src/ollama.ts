// Reference `RunClassifier` implementation backed by a local Ollama server.
// Three responsibilities live here:
//   1. Resource sanity check — refuse to run on undersized hardware.
//   2. Prompt packing — render the system+user prompts and drop older context
//      messages until the rendered prompt fits the configured num_ctx budget.
//   3. Validation — every classifier has a strict schema validator that
//      rejects malformed model output (raises `OllamaClassifierError`).
//
// Custom backend? Implement `RunClassifier` directly and pass it to
// `classifyOpenClassifyInput` — you don't have to use this module at all.

import { CLASSIFIERS, CLASSIFIER_NAMES } from "./classifiers.js";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import {
  DOWNSTREAM_EXECUTION_MODE_VALUES,
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
  SECURITY_RISK_LEVEL_VALUES,
  SECURITY_SIGNAL_VALUES,
  TERMINALITY_VALUES,
  TOOL_FAMILY_VALUES,
} from "./enums.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type {
  ClassifierInput,
  ClassifierName,
  ClassifierOutput,
  ConversationHistoryResult,
  ConversationMessageInput,
  DownstreamModelConfig,
  DownstreamModelConfigKey,
  RoutingResult,
  MemoryRetrievalQueriesResult,
  ModelSpecializationResult,
  OpenClassifyInput,
  OpenClassifyPipelineResult,
  OpenClassifyResult,
  PreflightResult,
  RunClassifier,
  SecurityResult,
  ToolsResult,
} from "./types.js";
import {
  ClassifierValidationError,
  ensureExactKeys,
  ensureNoDuplicates,
  isRecord,
  requireBoolean,
  requireEnum,
  requireNonEmptyStringMaxLength,
  requireNonNegativeSafeInteger,
  requireString,
  requireStringArray,
  requireStringMaxLength,
  throwInvalid,
} from "./validation.js";

export const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
export const OLLAMA_BASE_MODEL = "gemma4:e4b-it-q4_K_M";
export const OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH = 131_072;
export const OLLAMA_REQUIRED_PARALLELISM = 7;
export const OLLAMA_DEFAULT_ADAPTER_MODEL_CONFIG = "adapter-models.json";
export const OLLAMA_DEFAULT_DOWNSTREAM_MODEL_CONFIG = "downstream-models.json";

/*
 * Gemma 4 E4B's native context is 131,072 tokens (128K). The reference local
 * runtime is deliberately much smaller because Open Classify sends seven
 * classifiers in parallel on one workstation-class Ollama server. This is the
 * configured classifier runtime context, not the model's architectural maximum.
 */
export const OLLAMA_CONTEXT_LENGTH = 4096;
export const OLLAMA_MIN_TOTAL_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
export const OLLAMA_MIN_AVAILABLE_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;

const ESTIMATED_CHARS_PER_TOKEN = 3;
const PREFLIGHT_REPLY_MAX_CHARS = 200;
const CLASSIFIER_REASON_MAX_CHARS = 200;
const CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT = 19;
const CONVERSATION_HISTORY_REASON_MAX_CHARS = 200;
const MEMORY_QUERY_MAX_COUNT = 3;
const MEMORY_QUERY_MIN_WORDS = 3;
const MEMORY_QUERY_MAX_WORDS = 10;

const execFileAsync = promisify(execFile);

// Per-classifier model overrides. `null` means "use the base model with the
// classifier's system prompt." Values are filled in either from this default
// or from `adapter-models.json` via `discoverOllamaClassifierAdapterModels`.
export const OLLAMA_CLASSIFIER_MODELS = {
  preflight: null,
  routing: null,
  conversation_history: null,
  memory_retrieval_queries: null,
  tools: null,
  model_specialization: null,
  security: null,
} as const satisfies Record<ClassifierName, string | null>;

// Reference adapter model names — these are the LoRA/fine-tunes published as
// part of the Open Classify project. Useful as a starting point if you're
// pre-publishing your own adapters and want a versioned naming scheme.
export const OLLAMA_CLASSIFIER_ADAPTER_MODELS = {
  preflight: "open-classify-preflight:v0.1.0",
  routing: "open-classify-routing:v0.1.0",
  conversation_history: "open-classify-conversation-history:v0.1.0",
  memory_retrieval_queries: "open-classify-memory-retrieval-queries:v0.1.0",
  tools: "open-classify-tools:v0.1.0",
  model_specialization: "open-classify-model-specialization:v0.1.0",
  security: "open-classify-security:v0.1.0",
} as const satisfies Record<ClassifierName, string>;

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  seed?: number;
  num_ctx?: number;
}

export interface OllamaClassifierRunnerConfig {
  host?: string;
  adapterModelConfig?: string;
  models?: Partial<Record<ClassifierName, string | null>>;
  options?: OllamaOptions;
  fetch?: typeof fetch;
  skipResourceCheck?: boolean;
  minAvailableMemoryBytes?: number;
  minTotalMemoryBytes?: number;
}

export interface ClassifyWithOllamaConfig extends OllamaClassifierRunnerConfig {
  downstreamModels?: DownstreamModelConfig;
  downstreamModelConfig?: string;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  response?: string;
  error?: string;
}

export class OllamaClassifierError extends Error {
  readonly classifier: ClassifierName;
  readonly model: string;

  constructor(classifier: ClassifierName, model: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OllamaClassifierError";
    this.classifier = classifier;
    this.model = model;
  }
}

export class OllamaResourceError extends Error {
  readonly totalMemoryBytes: number;
  readonly availableMemoryBytes: number;
  readonly minTotalMemoryBytes: number;
  readonly minAvailableMemoryBytes: number;

  constructor(
    totalMemoryBytes: number,
    availableMemoryBytes: number,
    minTotalMemoryBytes: number,
    minAvailableMemoryBytes: number,
  ) {
    super(
      `Ollama resource check failed: ${formatBytes(totalMemoryBytes)} total and ${formatBytes(availableMemoryBytes)} available; ${formatBytes(minTotalMemoryBytes)} total and ${formatBytes(minAvailableMemoryBytes)} available required for ${OLLAMA_REQUIRED_PARALLELISM} parallel classifiers`,
    );
    this.name = "OllamaResourceError";
    this.totalMemoryBytes = totalMemoryBytes;
    this.availableMemoryBytes = availableMemoryBytes;
    this.minTotalMemoryBytes = minTotalMemoryBytes;
    this.minAvailableMemoryBytes = minAvailableMemoryBytes;
  }
}

// Build a `RunClassifier` bound to a specific Ollama host + model selection.
// The resource check is lazy and runs once per runner — the first classifier
// invocation pays for it; subsequent ones reuse the same promise.
export function createOllamaClassifierRunner(
  config: OllamaClassifierRunnerConfig = {},
): RunClassifier {
  const host = trimTrailingSlash(config.host ?? OLLAMA_DEFAULT_HOST);
  const fetchImpl = config.fetch ?? fetch;
  const models = {
    ...discoverOllamaClassifierAdapterModels(config.adapterModelConfig),
    ...config.models,
  };
  const options = {
    temperature: 0,
    num_ctx: OLLAMA_CONTEXT_LENGTH,
    ...config.options,
  };
  let resourceCheck: Promise<void> | undefined;

  return async <Name extends ClassifierName>(
    name: Name,
    input: ClassifierInput,
    signal: AbortSignal,
  ): Promise<ClassifierOutput<Name>> => {
    if (!config.skipResourceCheck) {
      resourceCheck ??= assertOllamaResources({
        minTotalMemoryBytes:
          config.minTotalMemoryBytes ?? OLLAMA_MIN_TOTAL_MEMORY_BYTES,
        minAvailableMemoryBytes:
          config.minAvailableMemoryBytes ?? OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
      });
      await resourceCheck;
    }

    const model = models[name] ?? OLLAMA_BASE_MODEL;
    return runOllamaClassifier(name, input, signal, fetchImpl, host, model, options);
  };
}

// Best-effort load of `adapter-models.json` (or the path the caller picks).
// Missing/malformed files are not fatal — we just return the all-null
// defaults so the base model gets used. If the file is partly populated,
// only the matching keys override; the rest stay null.
export function discoverOllamaClassifierAdapterModels(
  configPath = OLLAMA_DEFAULT_ADAPTER_MODEL_CONFIG,
): Record<ClassifierName, string | null> {
  const models: Record<ClassifierName, string | null> = { ...OLLAMA_CLASSIFIER_MODELS };
  if (!isFile(configPath)) {
    return models;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(parsed)) {
      return models;
    }

    for (const name of CLASSIFIER_NAMES) {
      const model = parsed[name];
      if (typeof model === "string" && model.trim().length > 0) {
        models[name] = model.trim();
      } else if (model === null) {
        models[name] = null;
      }
    }
  } catch {
    return models;
  }

  return models;
}

// Best-effort load of `downstream-models.json` (or the path the caller picks).
// Missing/malformed files are not fatal — returns {} so model resolves to null.
export function discoverDownstreamModels(
  configPath = OLLAMA_DEFAULT_DOWNSTREAM_MODEL_CONFIG,
): DownstreamModelConfig {
  if (!isFile(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isRecord(parsed)) return {};
    const result: DownstreamModelConfig = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim().length > 0) {
        result[key as DownstreamModelConfigKey] = value.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function assertOllamaResources(
  options: {
    minTotalMemoryBytes?: number;
    minAvailableMemoryBytes?: number;
  } = {},
): Promise<void> {
  const minTotalMemoryBytes =
    options.minTotalMemoryBytes ?? OLLAMA_MIN_TOTAL_MEMORY_BYTES;
  const minAvailableMemoryBytes =
    options.minAvailableMemoryBytes ?? OLLAMA_MIN_AVAILABLE_MEMORY_BYTES;
  const { totalMemoryBytes, availableMemoryBytes } = await getSystemMemoryBytes();

  if (
    totalMemoryBytes < minTotalMemoryBytes ||
    availableMemoryBytes < minAvailableMemoryBytes
  ) {
    throw new OllamaResourceError(
      totalMemoryBytes,
      availableMemoryBytes,
      minTotalMemoryBytes,
      minAvailableMemoryBytes,
    );
  }
}

export async function classifyWithOllama(
  input: OpenClassifyInput,
  config: ClassifyWithOllamaConfig = {},
): Promise<OpenClassifyPipelineResult> {
  let runnerConfig = config;
  if (!config.skipResourceCheck) {
    await assertOllamaResources({
      minTotalMemoryBytes: config.minTotalMemoryBytes,
      minAvailableMemoryBytes: config.minAvailableMemoryBytes,
    });
    runnerConfig = {
      ...config,
      skipResourceCheck: true,
    };
  }

  return classifyOpenClassifyInput(input, {
    runClassifier: createOllamaClassifierRunner(runnerConfig),
    downstreamModels:
      config.downstreamModels ?? discoverDownstreamModels(config.downstreamModelConfig),
  });
}

async function runOllamaClassifier<Name extends ClassifierName>(
  name: Name,
  input: ClassifierInput,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  host: string,
  model: string,
  options: OllamaOptions,
): Promise<ClassifierOutput<Name>> {
  const systemPrompt = CLASSIFIERS[name].systemPrompt;
  const userPrompt = buildPackedClassifierPrompt(name, input, systemPrompt, model, options);
  const body = {
    model,
    stream: false,
    format: "json",
    think: false,
    options,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new OllamaClassifierError(
      name,
      model,
      `${name} classifier request failed`,
      error,
    );
  }

  let payload: OllamaChatResponse;
  try {
    payload = ((await response.json()) ?? {}) as OllamaChatResponse;
  } catch (error) {
    throw new OllamaClassifierError(
      name,
      model,
      `${name} classifier returned invalid Ollama JSON`,
      error,
    );
  }

  if (!response.ok || payload.error !== undefined) {
    throw new OllamaClassifierError(
      name,
      model,
      `${name} classifier Ollama request failed: ${payload.error ?? response.statusText}`,
    );
  }

  const content = payload.message?.content ?? payload.response;
  if (typeof content !== "string") {
    throw new OllamaClassifierError(
      name,
      model,
      `${name} classifier response did not include message content`,
    );
  }

  const parsed = parseJsonObject(content, name, model);
  try {
    return validateClassifierOutput(name, parsed, model, input) as ClassifierOutput<Name>;
  } catch (error) {
    // Validation helpers throw the backend-neutral ClassifierValidationError.
    // The public Ollama API keeps OllamaClassifierError, so wrap at the
    // boundary instead of leaking the internal type.
    if (error instanceof ClassifierValidationError) {
      throw new OllamaClassifierError(name, model, error.message, error);
    }
    throw error;
  }
}

// Cross-platform "available memory" reading. On macOS, `os.freemem()` only
// counts truly idle pages and underreports badly when the system is using
// memory for cache; we shell out to `vm_stat` to get free + speculative +
// purgeable, which matches what Activity Monitor calls "available." On
// Linux/everywhere else we trust `os.freemem()`.
async function getSystemMemoryBytes(): Promise<{
  totalMemoryBytes: number;
  availableMemoryBytes: number;
}> {
  const os = await import("node:os");
  const totalMemoryBytes = os.totalmem();

  if (process.platform === "darwin") {
    const [{ stdout: pageSizeOutput }, { stdout: vmStatOutput }] = await Promise.all([
      execFileAsync("pagesize"),
      execFileAsync("vm_stat"),
    ]);

    const pageSize = Number(pageSizeOutput.trim());
    const freePages = readVmStatPages(vmStatOutput, "Pages free");
    const speculativePages = readVmStatPages(vmStatOutput, "Pages speculative");
    const purgeablePages = readVmStatPages(vmStatOutput, "Pages purgeable");
    return {
      totalMemoryBytes,
      availableMemoryBytes: (freePages + speculativePages + purgeablePages) * pageSize,
    };
  }

  return {
    totalMemoryBytes,
    availableMemoryBytes: os.freemem(),
  };
}

function readVmStatPages(output: string, label: string): number {
  const line = output
    .split("\n")
    .find((candidate) => candidate.trim().startsWith(`${label}:`));
  if (line === undefined) {
    return 0;
  }

  const match = line.match(/:\s+([0-9]+)\./);
  return match === null ? 0 : Number(match[1]);
}

/*
 * Prompt packing policy:
 *
 * The normalizer enforces coarse payload safety based on the reference runtime
 * budget. This runner enforces exact fit for the configured Ollama num_ctx
 * after the full classifier system prompt, wrapper text, conversation window,
 * and attachment metadata have been rendered.
 *
 * We intentionally do not truncate message text here. The final message is the
 * thing being classified, and chopping off its tail can change the route,
 * security posture, or memory hints in ways that look confident and are wrong.
 * Older context is useful but optional, so we drop older whole messages until
 * the fully rendered chat prompt fits the estimated context window. If the
 * target message alone does not fit, this runtime should fail clearly instead
 * of manufacturing a smaller, more convenient user request.
 *
 * This is not a tokenizer. It is the smallest honest heuristic: one named
 * assumption, applied to the full rendered prompt including the classifier
 * system prompt and our wrapper text. A model tokenizer would be more exact;
 * a pile of hidden constants would only be more decorative.
 */
function buildPackedClassifierPrompt(
  name: ClassifierName,
  input: ClassifierInput,
  systemPrompt: string,
  model: string,
  options: OllamaOptions,
): string {
  let messages = input.messages;
  let prompt = buildClassifierPrompt({
    ...input,
    messages,
  });

  while (
    !fitsEstimatedContext(systemPrompt, prompt, options) &&
    messages.length > 1
  ) {
    messages = messages.slice(1);
    prompt = buildClassifierPrompt({
      ...input,
      messages,
    });
  }

  if (!fitsEstimatedContext(systemPrompt, prompt, options)) {
    throw new OllamaClassifierError(
      name,
      model,
      `${name} classifier prompt exceeds estimated ${contextLength(options)} token context length with only the target message`,
    );
  }

  return prompt;
}

function fitsEstimatedContext(
  systemPrompt: string,
  userPrompt: string,
  options: OllamaOptions,
): boolean {
  return estimateTokens(`${systemPrompt}\n\n${userPrompt}`) <= contextLength(options);
}

function contextLength(options: OllamaOptions): number {
  return Number.isFinite(options.num_ctx)
    ? Math.floor(options.num_ctx as number)
    : OLLAMA_CONTEXT_LENGTH;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

function buildClassifierPrompt(input: ClassifierInput): string {
  const lines = [
    "Classify the final message in the normalized conversation window below.",
    "Earlier messages are context only; do not classify them as new requests.",
    "The target user message is the final message in the window.",
    "Use attachments as metadata only.",
    "Return JSON only.",
    "",
    "Conversation window:",
  ];

  for (const [index, message] of input.messages.entries()) {
    const label =
      index === input.messages.length - 1
        ? `Message ${index + 1} (target)`
        : `Message ${index + 1} (context)`;
    lines.push(`${label}:`);
    if (message.role !== undefined) {
      lines.push(`role: ${message.role}`);
    }
    lines.push("text:");
    lines.push(message.text);
    lines.push("");
  }

  lines.push(
    "Attachments:",
  );

  if (input.attachments.length === 0) {
    lines.push("none");
    return lines.join("\n");
  }

  for (const [index, attachment] of input.attachments.entries()) {
    lines.push(`- Attachment ${index + 1}:`);
    if (attachment.filename !== undefined) {
      lines.push(`  filename: ${attachment.filename}`);
    }
    if (attachment.mime_type !== undefined) {
      lines.push(`  mime_type: ${attachment.mime_type}`);
    }
    if (attachment.size_bytes !== undefined) {
      lines.push(`  size_bytes: ${attachment.size_bytes}`);
    }
  }

  return lines.join("\n");
}

function parseJsonObject(
  content: string,
  classifier: ClassifierName,
  model: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new OllamaClassifierError(
      classifier,
      model,
      `${classifier} classifier returned invalid JSON`,
      error,
    );
  }

  throw new OllamaClassifierError(
    classifier,
    model,
    `${classifier} classifier returned JSON that is not an object`,
  );
}

// Per-classifier validators below. They run on the model's parsed JSON and
// either return a typed result or throw `OllamaClassifierError`. Validation
// is strict on purpose: we'd rather surface a malformed response than ship
// downstream code a half-valid object that quietly misbehaves.
function validateClassifierOutput(
  name: ClassifierName,
  value: Record<string, unknown>,
  model: string,
  input?: ClassifierInput,
): OpenClassifyResult[ClassifierName] {
  switch (name) {
    case "preflight":
      return validatePreflight(value, name, model);
    case "routing":
      return validateRouting(value, name, model);
    case "conversation_history":
      return validateConversationHistory(value, name, model, input?.messages ?? []);
    case "memory_retrieval_queries":
      return validateMemoryRetrievalQueries(value, name, model);
    case "tools":
      return validateTools(value, name, model);
    case "model_specialization":
      return validateModelSpecialization(value, name, model);
    case "security":
      return validateSecurity(value, name, model);
  }
}

function validatePreflight(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): PreflightResult {
  ensureExactKeys(value, ["terminality", "reply", "reason"], name, model);
  const terminality = requireEnum(value.terminality, TERMINALITY_VALUES, name, model, "terminality");
  const reply = requireNonEmptyStringMaxLength(
    value.reply,
    name,
    model,
    "reply",
    PREFLIGHT_REPLY_MAX_CHARS,
  );
  return {
    terminality,
    reply,
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function validateRouting(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): RoutingResult {
  ensureExactKeys(value, ["execution_mode", "model_tier", "reason"], name, model);
  return {
    execution_mode: requireEnum(
      value.execution_mode,
      DOWNSTREAM_EXECUTION_MODE_VALUES,
      name,
      model,
      "execution_mode",
    ),
    model_tier: requireEnum(
      value.model_tier,
      DOWNSTREAM_MODEL_TIER_VALUES,
      name,
      model,
      "model_tier",
    ),
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function validateConversationHistory(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
  inputMessages: ConversationMessageInput[],
): ConversationHistoryResult {
  ensureExactKeys(
    value,
    [
      "is_standalone",
      "refers_to_history",
      "prior_messages_needed",
      "needs_unseen_history",
      "reason",
    ],
    name,
    model,
  );

  const priorMessagesNeeded = requireNonNegativeSafeInteger(
    value.prior_messages_needed,
    name,
    model,
    "prior_messages_needed",
  );
  if (priorMessagesNeeded > CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT) {
    throwInvalid(
      name,
      model,
      `prior_messages_needed must be ${CONVERSATION_HISTORY_PRIOR_MESSAGE_MAX_COUNT} or fewer`,
    );
  }

  const isStandalone = requireBoolean(value.is_standalone, name, model, "is_standalone");
  const refersToHistory = requireBoolean(
    value.refers_to_history,
    name,
    model,
    "refers_to_history",
  );
  const needsUnseenHistory = requireBoolean(
    value.needs_unseen_history,
    name,
    model,
    "needs_unseen_history",
  );

  if (
    isStandalone &&
    (refersToHistory || priorMessagesNeeded !== 0 || needsUnseenHistory)
  ) {
    throwInvalid(
      name,
      model,
      "standalone conversation_history must not require history",
    );
  }

  const relevantConversationHistory =
    priorMessagesNeeded > 0 && inputMessages.length > 1
      ? inputMessages.slice(-1 - priorMessagesNeeded, -1)
      : [];

  return {
    is_standalone: isStandalone,
    refers_to_history: refersToHistory,
    relevant_conversation_history: relevantConversationHistory,
    needs_unseen_history: needsUnseenHistory,
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CONVERSATION_HISTORY_REASON_MAX_CHARS,
    ),
  };
}

function validateMemoryRetrievalQueries(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): MemoryRetrievalQueriesResult {
  ensureExactKeys(value, ["queries", "reason"], name, model);
  const queries = requireStringArray(value.queries, name, model, "queries").map((query, index) => {
    const trimmed = query.trim();
    const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
    if (wordCount < MEMORY_QUERY_MIN_WORDS || wordCount > MEMORY_QUERY_MAX_WORDS) {
      throwInvalid(
        name,
        model,
        `queries[${index}] must be ${MEMORY_QUERY_MIN_WORDS} to ${MEMORY_QUERY_MAX_WORDS} words`,
      );
    }
    return trimmed;
  });

  if (queries.length > MEMORY_QUERY_MAX_COUNT) {
    throwInvalid(name, model, `queries must contain ${MEMORY_QUERY_MAX_COUNT} items or fewer`);
  }
  ensureNoDuplicates(queries, name, model, "queries");

  return {
    queries,
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function validateTools(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): ToolsResult {
  ensureExactKeys(value, ["needed", "families", "reason"], name, model);
  if (typeof value.needed !== "boolean") {
    throwInvalid(name, model, "needed must be a boolean");
  }
  if (!Array.isArray(value.families)) {
    throwInvalid(name, model, "families must be an array");
  }
  const families = value.families.map((item, index) =>
    requireEnum(item, TOOL_FAMILY_VALUES, name, model, `families[${index}]`),
  );
  ensureNoDuplicates(families, name, model, "families");
  if (value.needed !== (families.length > 0)) {
    throwInvalid(name, model, "needed must match whether families is non-empty");
  }

  return {
    needed: value.needed,
    families,
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function validateModelSpecialization(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): ModelSpecializationResult {
  ensureExactKeys(value, ["model_specialization", "reason"], name, model);
  return {
    model_specialization: requireEnum(
      value.model_specialization,
      MODEL_SPECIALIZATION_VALUES,
      name,
      model,
      "model_specialization",
    ),
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function validateSecurity(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): SecurityResult {
  ensureExactKeys(value, ["risk_level", "signals", "reason"], name, model);
  if (!Array.isArray(value.signals)) {
    throwInvalid(name, model, "signals must be an array");
  }

  const riskLevel = requireEnum(
    value.risk_level,
    SECURITY_RISK_LEVEL_VALUES,
    name,
    model,
    "risk_level",
  );
  const signals = value.signals.map((item, index) =>
    requireEnum(item, SECURITY_SIGNAL_VALUES, name, model, `signals[${index}]`),
  );
  ensureNoDuplicates(signals, name, model, "signals");

  if ((riskLevel === "normal" || riskLevel === "unable_to_determine") && signals.length > 0) {
    throwInvalid(name, model, `${riskLevel} risk_level must not include signals`);
  }
  if (riskLevel !== "normal" && riskLevel !== "unable_to_determine" && signals.length === 0) {
    throwInvalid(name, model, "elevated risk_level must include at least one signal");
  }

  return {
    risk_level: riskLevel,
    signals,
    reason: requireStringMaxLength(
      value.reason,
      name,
      model,
      "reason",
      CLASSIFIER_REASON_MAX_CHARS,
    ),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
