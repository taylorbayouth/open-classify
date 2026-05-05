import { CLASSIFIERS } from "./classifiers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CONTEXT_SUFFICIENCY_VALUES,
  DOWNSTREAM_ROUTE_VALUES,
  SECURITY_POSTURE_VALUES,
  SECURITY_SIGNAL_VALUES,
  TERMINALITY_VALUES,
  TOOL_FAMILY_VALUES,
} from "./enums.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type {
  ContextSufficiencyResult,
  ClassifierInput,
  ClassifierName,
  ClassifierOutput,
  DownstreamRouteResult,
  MemoryRetrievalQueriesResult,
  MessageAndAttachmentDigestResult,
  OpenClassifyInput,
  OpenClassifyPipelineResult,
  OpenClassifyResult,
  PreflightResult,
  RunClassifier,
  SecurityPostureResult,
  ToolFamilyNeedResult,
} from "./types.js";

export const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
export const OLLAMA_BASE_MODEL = "gemma4:e4b-it-q4_K_M";
export const OLLAMA_REQUIRED_PARALLELISM = 7;
export const OLLAMA_CONTEXT_LENGTH = 4096;
export const OLLAMA_MIN_TOTAL_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
export const OLLAMA_MIN_AVAILABLE_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;

const ESTIMATED_CHARS_PER_TOKEN = 3;
const CONTEXT_MISSING_MAX_COUNT = 5;
const MEMORY_QUERY_MAX_COUNT = 3;
const MEMORY_QUERY_MIN_WORDS = 3;
const MEMORY_QUERY_MAX_WORDS = 10;
const DIGEST_SUMMARY_MAX_CHARS = 160;
const DIGEST_SLUG_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const execFileAsync = promisify(execFile);

export const OLLAMA_CLASSIFIER_MODELS = {
  preflight: null,
  downstream_route: null,
  context_sufficiency: null,
  memory_retrieval_queries: null,
  tool_family_need: null,
  message_and_attachment_digest: null,
  security_posture: null,
} as const satisfies Record<ClassifierName, string | null>;

export const OLLAMA_CLASSIFIER_ADAPTER_MODELS = {
  preflight: "open-classify-preflight:v0.1.0",
  downstream_route: "open-classify-downstream-route:v0.1.0",
  context_sufficiency: "open-classify-context-sufficiency:v0.1.0",
  memory_retrieval_queries: "open-classify-memory-retrieval-queries:v0.1.0",
  tool_family_need: "open-classify-tool-family-need:v0.1.0",
  message_and_attachment_digest: "open-classify-message-and-attachment-digest:v0.1.0",
  security_posture: "open-classify-security-posture:v0.1.0",
} as const satisfies Record<ClassifierName, string>;

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  seed?: number;
  num_ctx?: number;
}

export interface OllamaClassifierRunnerConfig {
  host?: string;
  models?: Partial<Record<ClassifierName, string | null>>;
  options?: OllamaOptions;
  fetch?: typeof fetch;
  skipResourceCheck?: boolean;
  minAvailableMemoryBytes?: number;
  minTotalMemoryBytes?: number;
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
  readonly cause: unknown;

  constructor(classifier: ClassifierName, model: string, message: string, cause?: unknown) {
    super(message);
    this.name = "OllamaClassifierError";
    this.classifier = classifier;
    this.model = model;
    this.cause = cause;
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

export function createOllamaClassifierRunner(
  config: OllamaClassifierRunnerConfig = {},
): RunClassifier {
  const host = trimTrailingSlash(config.host ?? OLLAMA_DEFAULT_HOST);
  const fetchImpl = config.fetch ?? fetch;
  const models = { ...OLLAMA_CLASSIFIER_MODELS, ...config.models };
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
  config: OllamaClassifierRunnerConfig = {},
): Promise<OpenClassifyPipelineResult> {
  return classifyOpenClassifyInput(input, {
    runClassifier: createOllamaClassifierRunner(config),
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
    payload = (await response.json()) as OllamaChatResponse;
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
  return validateClassifierOutput(name, parsed, model) as ClassifierOutput<Name>;
}

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
 * The normalizer enforces coarse payload safety. This runner enforces runtime
 * fit. Those are different jobs. A 32k character payload is a perfectly
 * reasonable thing to accept at an API boundary and a perfectly unreasonable
 * thing to shove blindly into a 4096-token local classifier. Boundaries are
 * where optimism goes to become incident review notes.
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
  let conversationWindow = input.conversation_window;
  let prompt = buildClassifierPrompt({
    ...input,
    conversation_window: conversationWindow,
  });

  while (
    !fitsEstimatedContext(systemPrompt, prompt, options) &&
    conversationWindow.length > 1
  ) {
    conversationWindow = conversationWindow.slice(1);
    prompt = buildClassifierPrompt({
      ...input,
      conversation_window: conversationWindow,
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

  for (const [index, message] of input.conversation_window.entries()) {
    const label =
      index === input.conversation_window.length - 1
        ? `Message ${index + 1} (target)`
        : `Message ${index + 1} (context)`;
    lines.push(`${label}:`);
    if (message.role !== undefined) {
      lines.push(`role: ${message.role}`);
    }
    if (message.message_id !== undefined) {
      lines.push(`message_id: ${message.message_id}`);
    }
    if (message.timestamp !== undefined) {
      lines.push(`timestamp: ${message.timestamp}`);
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

function validateClassifierOutput(
  name: ClassifierName,
  value: Record<string, unknown>,
  model: string,
): OpenClassifyResult[ClassifierName] {
  switch (name) {
    case "preflight":
      return validatePreflight(value, name, model);
    case "downstream_route":
      return validateDownstreamRoute(value, name, model);
    case "context_sufficiency":
      return validateContextSufficiency(value, name, model);
    case "memory_retrieval_queries":
      return validateMemoryRetrievalQueries(value, name, model);
    case "tool_family_need":
      return validateToolFamilyNeed(value, name, model);
    case "message_and_attachment_digest":
      return validateMessageAndAttachmentDigest(value, name, model);
    case "security_posture":
      return validateSecurityPosture(value, name, model);
  }
}

function validatePreflight(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): PreflightResult {
  const terminality = requireEnum(value.terminality, TERMINALITY_VALUES, name, model, "terminality");
  const awk = requireString(value.awk, name, model, "awk");
  return { terminality, awk };
}

function validateDownstreamRoute(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): DownstreamRouteResult {
  return {
    value: requireEnum(value.value, DOWNSTREAM_ROUTE_VALUES, name, model, "value"),
  };
}

function validateContextSufficiency(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): ContextSufficiencyResult {
  const selected = requireEnum(value.value, CONTEXT_SUFFICIENCY_VALUES, name, model, "value");
  const missing = requireStringArray(value.missing, name, model, "missing");
  if (missing.length > CONTEXT_MISSING_MAX_COUNT) {
    throwInvalid(name, model, `missing must contain ${CONTEXT_MISSING_MAX_COUNT} items or fewer`);
  }

  return {
    value: selected,
    missing,
  };
}

function validateMemoryRetrievalQueries(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): MemoryRetrievalQueriesResult {
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

  return { queries };
}

function validateToolFamilyNeed(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): ToolFamilyNeedResult {
  if (!Array.isArray(value.value)) {
    throwInvalid(name, model, "value must be an array");
  }
  const selected = value.value.map((item, index) =>
    requireEnum(item, TOOL_FAMILY_VALUES, name, model, `value[${index}]`),
  );
  ensureNoDuplicates(selected, name, model, "value");

  return { value: selected };
}

function validateMessageAndAttachmentDigest(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): MessageAndAttachmentDigestResult {
  if (!Array.isArray(value.attachments)) {
    throwInvalid(name, model, "attachments must be an array");
  }

  const slug = requireString(value.slug, name, model, "slug");
  if (!DIGEST_SLUG_PATTERN.test(slug)) {
    throwInvalid(name, model, "slug must be snake_case");
  }

  return {
    slug,
    summary: requireStringMaxLength(value.summary, name, model, "summary", DIGEST_SUMMARY_MAX_CHARS),
    attachments: value.attachments.map((attachment, index) => {
      if (!isRecord(attachment)) {
        throwInvalid(name, model, `attachments[${index}] must be an object`);
      }

      const result = {
        filename: requireString(attachment.filename, name, model, `attachments[${index}].filename`),
        summary: requireStringMaxLength(
          attachment.summary,
          name,
          model,
          `attachments[${index}].summary`,
          DIGEST_SUMMARY_MAX_CHARS,
        ),
      };

      return {
        ...result,
        ...(attachment.size_bytes === undefined
          ? {}
          : {
              size_bytes: requireNonNegativeSafeInteger(
                attachment.size_bytes,
                name,
                model,
                `attachments[${index}].size_bytes`,
              ),
            }),
        ...(attachment.mime_type === undefined
          ? {}
          : {
              mime_type: requireString(
                attachment.mime_type,
                name,
                model,
                `attachments[${index}].mime_type`,
              ),
            }),
      };
    }),
  };
}

function validateSecurityPosture(
  value: Record<string, unknown>,
  name: ClassifierName,
  model: string,
): SecurityPostureResult {
  if (!Array.isArray(value.signals)) {
    throwInvalid(name, model, "signals must be an array");
  }

  const selected = requireEnum(value.value, SECURITY_POSTURE_VALUES, name, model, "value");
  const signals = value.signals.map((item, index) =>
    requireEnum(item, SECURITY_SIGNAL_VALUES, name, model, `signals[${index}]`),
  );
  ensureNoDuplicates(signals, name, model, "signals");

  if (selected === "normal" && signals.length > 0) {
    throwInvalid(name, model, "normal posture must not include signals");
  }
  if (selected !== "normal" && signals.length === 0) {
    throwInvalid(name, model, "non-normal posture must include at least one signal");
  }

  return {
    value: selected,
    signals,
    notes: requireString(value.notes, name, model, "notes"),
  };
}

function requireString(
  value: unknown,
  classifier: ClassifierName,
  model: string,
  path: string,
): string {
  if (typeof value !== "string") {
    throwInvalid(classifier, model, `${path} must be a string`);
  }
  return value;
}

function requireNonNegativeSafeInteger(
  value: unknown,
  classifier: ClassifierName,
  model: string,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throwInvalid(classifier, model, `${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  classifier: ClassifierName,
  model: string,
  path: string,
): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throwInvalid(classifier, model, `${path} must be an array of strings`);
  }
  return value;
}

function requireStringMaxLength(
  value: unknown,
  classifier: ClassifierName,
  model: string,
  path: string,
  maxChars: number,
): string {
  const text = requireString(value, classifier, model, path);
  if (text.length > maxChars) {
    throwInvalid(classifier, model, `${path} must be ${maxChars} characters or fewer`);
  }
  return text;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  classifier: ClassifierName,
  model: string,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throwInvalid(classifier, model, `${path} has an unsupported value`);
  }
  return value;
}

function throwInvalid(
  classifier: ClassifierName,
  model: string,
  message: string,
): never {
  throw new OllamaClassifierError(
    classifier,
    model,
    `${classifier} classifier returned invalid output: ${message}`,
  );
}

function ensureNoDuplicates(
  values: string[],
  classifier: ClassifierName,
  model: string,
  path: string,
): void {
  if (new Set(values).size !== values.length) {
    throwInvalid(classifier, model, `${path} must not include duplicates`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
