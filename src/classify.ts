/**
 * The classifier orchestrator.
 *
 * {@link classify} fans out to every entry in {@link CLASSIFIERS} in parallel,
 * collects their results, and returns one record per dimension. Each call uses
 * its own model (per-dimension config), has an independent timeout, and is
 * validated against the dimension's schema. One sub-classifier failing or
 * timing out does not affect the others; its record is still emitted with
 * `validation_status` reflecting the failure.
 *
 * Pass `onEvent` to stream per-dimension records as they complete (used by the
 * NDJSON server endpoint). The same records are returned in
 * {@link ClassifyResult.sub_results} once all entries settle.
 */
import OpenAI from "openai";
import { z } from "zod";
import type {
  InputEnvelope,
  SubResultEvent,
  SubResultRecord,
  ValidationStatus,
} from "./schema.js";
import { CLASSIFIERS, DIMENSION_KEYS, type DimensionName } from "./classifiers.js";
import {
  type ClassifierConfig,
  type ClassifiersConfig,
  parseModelString,
} from "./config.js";

function createClient(config: ClassifierConfig): OpenAI {
  const { provider } = parseModelString(config.model);
  if (provider === "ollama") {
    return new OpenAI({
      baseURL: config.base_url ?? "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  }
  return new OpenAI({ apiKey: config.api_key ?? process.env.OPENAI_API_KEY });
}

/**
 * Best-effort JSON extraction from a model response.
 *
 * Strips `<think>...</think>` reasoning blocks first (some models emit them
 * regardless of the thinking flag, and stray braces inside them would confuse
 * the brace scan), then handles markdown code fences, then falls back
 * to scanning for the first `{` and last `}`. Returns `null` when no JSON
 * object can be located.
 *
 * Exported so it can be unit-tested directly — see `tests/extract-json.test.ts`.
 */
export function extractJson(text: string): string | null {
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const stripped = noThink.replace(/```(?:json)?\n?([\s\S]*?)```/g, "$1").trim();
  if (stripped.startsWith("{")) return stripped;
  const start = noThink.indexOf("{");
  const end = noThink.lastIndexOf("}");
  if (start !== -1 && end > start) return noThink.slice(start, end + 1);
  return null;
}

interface RawCallResult<T> {
  data: T | null;
  latency_ms: number;
  raw: string;
  validation_status: ValidationStatus;
}

async function callSubClassifier<T>(
  schema: z.ZodSchema<T>,
  systemPrompt: string,
  userInput: string,
  config: ClassifierConfig
): Promise<RawCallResult<T>> {
  const start = Date.now();
  const client = createClient(config);
  const { name } = parseModelString(config.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);

  try {
    const response = await client.chat.completions.create(
      {
        model: name,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInput },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        // @ts-ignore — ollama-specific thinking option
        ...(config.think ? { think: true } : {}),
      },
      { signal: controller.signal }
    );
    const raw = response.choices[0]?.message?.content ?? "";
    const extracted = extractJson(raw);
    if (!extracted) {
      return { data: null, latency_ms: Date.now() - start, raw, validation_status: "invalid_json" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return { data: null, latency_ms: Date.now() - start, raw, validation_status: "invalid_json" };
    }

    const result = schema.safeParse(parsed);
    return {
      data: result.success ? result.data : null,
      latency_ms: Date.now() - start,
      raw,
      validation_status: result.success ? "valid" : "schema_error",
    };
  } catch (err) {
    return {
      data: null,
      latency_ms: Date.now() - start,
      raw: String(err),
      validation_status: "classifier_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Aggregate result of a {@link classify} call. */
export interface ClassifyResult {
  /** Wall-clock time from invocation to all sub-classifiers settling, in ms. Bounded by the slowest call (assuming the backend supports concurrency). */
  total_latency_ms: number;
  /** One record per dimension, in {@link DIMENSION_KEYS} order. */
  sub_results: SubResultRecord[];
}

/**
 * Run every classifier in {@link CLASSIFIERS} in parallel and collect results.
 *
 * @param envelope - User input + a caller-provided `request_id` for trace correlation.
 * @param configs - Per-dimension classifier configs (typically `loadConfig().classifiers`).
 *   Each config may carry an optional `prompt` field that overrides the
 *   registry's default prompt for that classifier.
 * @param onEvent - Optional callback fired each time a sub-classifier settles.
 *   Used by the streaming server endpoint to forward results as NDJSON. Records
 *   are emitted in completion order, not registry order.
 * @returns Aggregated {@link ClassifyResult}. Always resolves; per-dimension
 *   failures surface via `validation_status` on each record rather than
 *   rejecting the promise.
 */
export async function classify(
  envelope: InputEnvelope,
  configs: ClassifiersConfig,
  onEvent?: (event: SubResultEvent) => void
): Promise<ClassifyResult> {
  const start = Date.now();
  const input = envelope.user_input;

  const settled = await Promise.all(
    DIMENSION_KEYS.map(async (dim: DimensionName) => {
      const cfg = configs[dim];
      const prompt = cfg.prompt ?? CLASSIFIERS[dim].prompt;
      const schema = CLASSIFIERS[dim].schema as z.ZodSchema<unknown>;
      const r = await callSubClassifier(schema, prompt, input, cfg);

      const record: SubResultRecord = {
        dimension: dim,
        data: r.data,
        latency_ms: r.latency_ms,
        raw_output: r.raw,
        prompt,
        model: cfg.model,
        validation_status: r.validation_status,
      };

      process.stderr.write(
        `[classify] ${dim} (${r.latency_ms}ms) [${cfg.model}] input="${input.replace(/\n/g, " ").slice(0, 80)}" raw=${r.raw}\n`
      );

      onEvent?.({ type: "sub_result", ...record });

      return record;
    })
  );

  return {
    total_latency_ms: Date.now() - start,
    sub_results: settled,
  };
}
