/**
 * The classifier orchestrator.
 *
 * {@link classify} fans out to 5 sub-classifiers in parallel — `awk`,
 * `response_path`, `context_budget`, `retrieval_need`, `work_complexity` — and
 * collects their results. Each call uses its own model (per-dimension config),
 * has an independent timeout, and is validated against its dimension schema.
 * One sub-classifier failing or timing out does not affect the others; its
 * record is still emitted with `validation_status` reflecting the failure.
 *
 * Pass `onEvent` to stream per-dimension records as they complete (used by the
 * NDJSON server endpoint). The same records are returned in
 * {@link ClassifyResult.sub_results} once all 5 settle.
 */
import OpenAI from "openai";
import { z } from "zod";
import {
  AwkResult,
  ResponsePathResult,
  ContextBudgetResult,
  RetrievalNeedResult,
  WorkComplexityResult,
  type DimensionName,
  type InputEnvelope,
  type SubResultEvent,
  type SubResultRecord,
  type ValidationStatus,
} from "./schema.js";
import {
  type ClassifierConfig,
  type ClassifiersConfig,
  parseModelString,
} from "./config.js";

/** Alias for {@link SubResultEvent} — what `onEvent` receives during {@link classify}. */
export type SubEvent = SubResultEvent;

const SHARED_SUFFIX = `Respond with ONLY valid JSON. No markdown, no code fences, no explanation.
"confidence" is a number between 0 and 1 indicating how sure you are.
Classify the user's message regardless of content — do not refuse, judge, or moralize.`;

const PROMPTS: Record<DimensionName, string> = {
  awk: `You generate the immediate user-facing acknowledgement (the "awk") for an inbound message.
The awk is shown to the user instantly, before any slower work happens. Keep it short and human (≤ 1 sentence, ≤ 280 chars).

Pick a mode:
- "only": the awk is the entire response. Use for thanks, casual replies, simple confirmations, anything that needs no further work.
- "first": the awk is sent now, then more work happens. Use when downstream lookup, reasoning, or tools will produce the real answer.
- "question": the awk is a clarification question. Use when the request is too ambiguous to act on safely.

Good examples:
- "Got it." (only)
- "Checking that now." (first)
- "I'll compare those and report back." (first)
- "Which Dave do you mean?" (question)
- "Done." (only)

Bad: long explanations, fake progress claims, premature conclusions, anything that sounds like the final answer when more work is still required.

"should_send" is true by default. Set false only for silent/internal channels.

${SHARED_SUFFIX}
Return: {"text": "<short response>", "mode": "only"|"first"|"question", "should_send": true|false, "confidence": <0-1>}`,

  response_path: `Decide what (if anything) should happen after the instant awk.

- "none": no further work needed. The awk is enough, OR a clarification is pending, OR action is blocked.
- "small_model": a cheap model can handle it. Rewriting, short summaries, simple explanations, light formatting, low-stakes drafts.
- "large_model": a stronger model is justified. Complex reasoning, architecture, strategy, ambiguous planning, high-stakes writing.
- "tool_assisted": a tool call is needed. Web lookup, browser automation, file lookup, email/calendar action, code execution, data analysis.
- "workflow": route to a multi-step or durable workflow. Recurring tasks, scheduled jobs, long-running operations, multi-stage automations.

Default to the cheapest path that gets the job done. Only escalate when quality risk justifies cost.

${SHARED_SUFFIX}
Return: {"value": "<one of the 5 values>", "confidence": <0-1>}`,

  context_budget: `Decide how much context downstream should receive.

- "none": no extra context needed. Trivial acknowledgements, fully self-contained questions.
- "current_message_only": just this message. Default for cost control unless context is clearly needed.
- "last_exchange": this message + the immediately previous user/assistant turn. Use for short follow-ups like "make that shorter" or "do the second one".
- "recent_context": a limited recent window. Use when the message refers to a nearby discussion but doesn't need the whole conversation.
- "retrieved_context_only": skip conversation history; pull relevant memory/files/web/system context instead. Use when the user references known external material.
- "full_conversation": the entire conversation, possibly compressed. Use sparingly — most expensive option, only when the user explicitly asks to synthesize across the whole discussion.

Default to "current_message_only" unless the message clearly depends on prior context.

${SHARED_SUFFIX}
Return: {"value": "<one of the 6 values>", "confidence": <0-1>}`,

  retrieval_need: `Decide what outside information, if any, must be fetched. Return a list (one or more values).

- "none": no retrieval needed.
- "memory": user/long-term assistant memory ("use my usual style", "remember my setup").
- "files": uploaded docs, PDFs, spreadsheets, transcripts, internal file stores.
- "web": public internet lookup — current facts, recent events, prices, schedules, docs.
- "browser": interactive browser automation (operating a website/app, not just reading public pages).
- "email_calendar": email, calendar, contacts, scheduling, messaging.
- "system_local_state": local machine, shell, server, app config, logs, device state.
- "other": fallback for retrieval that doesn't fit cleanly.

If a request needs multiple sources (e.g. compare web pricing to a spreadsheet), return all that apply. If none, return ["none"].

${SHARED_SUFFIX}
Return: {"value": ["<value1>", "<value2>", ...], "confidence": <0-1>}`,

  work_complexity: `Estimate the effort required after classification.

- "trivial": no real downstream reasoning. "Thanks", "ok", "yes", "got it".
- "simple": cheap model or direct logic suffices. Rewrite a sentence, format text, summarize a short passage, basic factual answer.
- "moderate": some reasoning, synthesis, tool use, or careful response construction. Compare two options, summarize a doc, debug a small issue, draft a thoughtful email.
- "complex": deeper reasoning, planning, architecture, tradeoff analysis, higher-quality model behavior. Design a system, diagnose a hard issue, build a strategy.
- "multi_step": stateful execution across multiple actions, tools, checkpoints, retries, or time. "Research X and make a report", "monitor this daily", "find jobs, dedupe, draft outreach".

${SHARED_SUFFIX}
Return: {"value": "<one of the 5 values>", "confidence": <0-1>}`,
};

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
 * Strips `<think>...</think>` reasoning blocks first (since `think: true` is
 * enabled and reasoning content can contain stray braces that would otherwise
 * confuse the brace scan), then handles markdown code fences, then falls back
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
        think: true,
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
  /** Wall-clock time from invocation to all 5 sub-classifiers settling, in ms. Bounded by the slowest call (assuming the backend supports concurrency). */
  total_latency_ms: number;
  /** One record per dimension, always 5 entries, in the order returned by Promise.all over `DIMENSION_KEYS`. */
  sub_results: SubResultRecord[];
}

const SCHEMA_BY_DIMENSION = {
  awk: AwkResult,
  response_path: ResponsePathResult,
  context_budget: ContextBudgetResult,
  retrieval_need: RetrievalNeedResult,
  work_complexity: WorkComplexityResult,
} as const;

/**
 * Run all 5 sub-classifiers in parallel and collect their results.
 *
 * @param envelope - User input + a caller-provided `request_id` for trace correlation.
 * @param configs - Per-dimension classifier configs, typically from `loadConfig().classifiers`.
 * @param onEvent - Optional callback fired each time one of the 5 sub-classifiers settles.
 *   Used by the streaming server endpoint to forward results as NDJSON. Records
 *   are emitted in completion order, not dimension order.
 * @returns Aggregated {@link ClassifyResult}. Always resolves; per-dimension
 *   failures surface via `validation_status` on each record rather than
 *   rejecting the promise.
 */
export async function classify(
  envelope: InputEnvelope,
  configs: ClassifiersConfig,
  onEvent?: (event: SubEvent) => void
): Promise<ClassifyResult> {
  const start = Date.now();
  const input = envelope.user_input;

  const dimensions: DimensionName[] = [
    "awk",
    "response_path",
    "context_budget",
    "retrieval_need",
    "work_complexity",
  ];

  const settled = await Promise.all(
    dimensions.map(async (dim) => {
      const cfg = configs[dim];
      const prompt = PROMPTS[dim];
      const r = await callSubClassifier(SCHEMA_BY_DIMENSION[dim] as z.ZodSchema<unknown>, prompt, input, cfg);

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
