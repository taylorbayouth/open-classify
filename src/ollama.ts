// Reference `RunClassifier` implementation backed by a local Ollama server.
// Three responsibilities live here:
//   1. Resource sanity check — refuse to run on undersized hardware.
//   2. Prompt packing — render the system+user prompts and drop older context
//      messages until the rendered prompt fits the configured num_ctx budget.
//   3. Backend wiring — call Ollama, parse JSON, and delegate validation to
//      each classifier module's `validate` function.
//
// Custom backend? Implement `RunClassifier` directly and pass it to
// `classifyOpenClassifyInput` — you don't have to use this module at all.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCatalog } from "./catalog.js";
import {
  CLASSIFIER_NAMES,
  MODULES_BY_NAME,
  validateClassifierOutput,
  type ClassifierName,
  type RunClassifier,
} from "./classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
  type OpenClassifyConfig,
} from "./config.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type { Catalog } from "./manifest.js";
import type { ClassifierOutput } from "./stock.js";
import type {
  ClassifierInput,
  OpenClassifyInput,
} from "./types.js";
import {
  ClassifierValidationError,
  isRecord,
} from "./validation.js";

export const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
export const OLLAMA_BASE_MODEL = "gemma4:e4b-it-q4_K_M";
export const OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH = 131_072;
export const OLLAMA_REQUIRED_PARALLELISM = CLASSIFIER_NAMES.length;
export const OLLAMA_DEFAULT_CATALOG_PATH = "downstream-models.json";

/*
 * Gemma 4 E4B's native context is 131,072 tokens (128K). The reference local
 * runtime is deliberately much smaller because Open Classify sends multiple
 * classifiers in parallel on one workstation-class Ollama server. This is the
 * configured classifier runtime context, not the model's architectural maximum.
 */
export const OLLAMA_CONTEXT_LENGTH = 4096;
export const OLLAMA_MIN_TOTAL_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
export const OLLAMA_MIN_AVAILABLE_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;

const ESTIMATED_CHARS_PER_TOKEN = 3;

const execFileAsync = promisify(execFile);

export const OLLAMA_CLASSIFIER_MODELS = Object.fromEntries(
  CLASSIFIER_NAMES.map((name) => [name, null]),
) as Record<ClassifierName, string | null>;

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  seed?: number;
  num_ctx?: number;
}

export interface OllamaClassifierRunnerConfig {
  host?: string;
  defaultModel?: string;
  models?: Partial<Record<ClassifierName, string | null>>;
  options?: OllamaOptions;
  fetch?: typeof fetch;
  skipResourceCheck?: boolean;
  minAvailableMemoryBytes?: number;
  minTotalMemoryBytes?: number;
}

// Top-level helper that combines the runner + the catalog. Callers who only
// want to run a single classification end-to-end can use this; callers who
// need finer control should build the pieces themselves.
export interface ClassifyWithOllamaConfig extends OllamaClassifierRunnerConfig {
  catalog?: Catalog;
  catalogPath?: string;
  configPath?: string;
  openClassifyConfig?: OpenClassifyConfig;
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
  const models = config.models ?? {};
  const defaultModel = config.defaultModel ?? OLLAMA_BASE_MODEL;
  const hasDefaultModelOverride = config.defaultModel !== undefined;
  const options = {
    temperature: 0,
    num_ctx: OLLAMA_CONTEXT_LENGTH,
    ...config.options,
  };
  let resourceCheck: Promise<void> | undefined;

  return async (
    name,
    input: ClassifierInput,
    signal: AbortSignal,
  ) => {
    if (!config.skipResourceCheck) {
      resourceCheck ??= assertOllamaResources({
        minTotalMemoryBytes:
          config.minTotalMemoryBytes ?? OLLAMA_MIN_TOTAL_MEMORY_BYTES,
        minAvailableMemoryBytes:
          config.minAvailableMemoryBytes ?? OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
      });
      await resourceCheck;
    }

    const configuredModel = models[name];
    const model = configuredModel ?? defaultModel;
    return runOllamaClassifier(
      name,
      input,
      signal,
      fetchImpl,
      host,
      model,
      options,
      configuredModel === undefined && !hasDefaultModelOverride,
    );
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
  config: ClassifyWithOllamaConfig = {},
): ReturnType<typeof classifyOpenClassifyInput> {
  const fileConfig = config.openClassifyConfig ?? loadOpenClassifyConfig(config.configPath, {
    optional: config.configPath === undefined && process.env.OPEN_CLASSIFY_CONFIG === undefined,
  });
  const runnerFileConfig = fileConfig?.runner;
  const runnerConfig: OllamaClassifierRunnerConfig = {
    ...config,
    host: config.host ?? runnerFileConfig?.host,
    defaultModel: config.defaultModel ?? runnerFileConfig?.defaultModel,
    models: {
      ...classifierModelsFromConfig(fileConfig),
      ...config.models,
    },
    options: {
      ...runnerFileConfig?.options,
      ...config.options,
    },
  };

  if (!runnerConfig.skipResourceCheck) {
    await assertOllamaResources({
      minTotalMemoryBytes: runnerConfig.minTotalMemoryBytes,
      minAvailableMemoryBytes: runnerConfig.minAvailableMemoryBytes,
    });
    Object.assign(runnerConfig, {
      skipResourceCheck: true,
    });
  }

  const catalog = config.catalog ?? loadCatalog(
    config.catalogPath ?? fileConfig?.catalog ?? OLLAMA_DEFAULT_CATALOG_PATH,
  );

  return classifyOpenClassifyInput(input, {
    runClassifier: createOllamaClassifierRunner(runnerConfig),
    catalog,
  });
}

async function runOllamaClassifier(
  name: ClassifierName,
  input: ClassifierInput,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  host: string,
  model: string,
  options: OllamaOptions,
  allowManifestModel: boolean,
): Promise<ClassifierOutput> {
  const module_ = MODULES_BY_NAME[name];
  const systemPrompt = module_.systemPrompt;
  const configuredBaseModel = module_.backend?.ollama?.base_model;
  if (allowManifestModel && configuredBaseModel) {
    model = configuredBaseModel;
  }
  const userPrompt = buildPackedClassifierPrompt(name, input, systemPrompt, model, options);
  const body = {
    model,
    stream: false,
    format: "json",
    think: false,
    options,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
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
    return validateClassifierOutput(name, parsed, model);
  } catch (error) {
    if (error instanceof ClassifierValidationError) {
      throw new OllamaClassifierError(name, model, error.message, error);
    }
    throw error;
  }
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

  lines.push("Attachments:");

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
  const json = unwrapJsonFence(content);
  try {
    const parsed = JSON.parse(json) as unknown;
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

function unwrapJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
