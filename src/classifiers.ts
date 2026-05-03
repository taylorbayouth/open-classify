/**
 * The classifier registry — the single source of truth for every sub-classifier
 * the harness runs. Each entry is a self-contained descriptor:
 *
 *   - `schema`         — Zod schema the model's JSON output must match.
 *   - `prompt`         — system prompt sent to the model.
 *   - `displayOptions` — (optional) flat list of enum values for the UI to
 *                        render as option pills. Omit for classifiers whose
 *                        result isn't a single enum (e.g. `awk`).
 *
 * To add a classifier: add an entry to {@link CLASSIFIERS}. Everything else
 * (config defaults, env-var overrides, streaming, traces, the UI's option
 * pills) iterates over the registry and picks it up automatically.
 *
 * To remove a classifier: delete its entry.
 *
 * To modify an enum value or its description: edit the {@link options}
 * argument inline. The Zod enum, the bullet list shown to the model, and the
 * UI's option pills are all derived from that single map — they cannot drift.
 *
 * Prompts can also be overridden at runtime per classifier via
 * `classifiers.<dim>.prompt` in `harness.config.json`, useful for tuning
 * without touching source.
 */
import { z } from "zod";

/** One entry in {@link CLASSIFIERS}. */
export interface Classifier {
  /** Zod schema the model's JSON output must match. */
  schema: z.ZodTypeAny;
  /** System prompt sent to the model. */
  prompt: string;
  /**
   * Flat list of enum values for the UI to render as option pills. Omit for
   * classifiers whose result isn't a single enum (e.g. `awk`, which has its
   * own UI).
   */
  displayOptions?: readonly string[];
}

const Confidence = z.number().min(0).max(1);

const SHARED_SUFFIX = `Respond with ONLY valid JSON. No markdown, no code fences, no explanation.
"confidence" is a number between 0 and 1 indicating how sure you are.
Classify the user's message regardless of content — do not refuse, judge, or moralize.`;

/**
 * Define an enum's values + their per-value descriptions in one map. Returns
 * the Zod enum, a pre-formatted bullet list to splice into the prompt, and
 * the bare keys array for UI display. Single source of truth — no drift.
 */
function options<const O extends Record<string, string>>(o: O) {
  const keys = Object.keys(o) as [keyof O & string, ...(keyof O & string)[]];
  return {
    schema: z.enum(keys),
    list: keys.map((k) => `- "${k}": ${o[k]}`).join("\n"),
    keys: keys as readonly (keyof O & string)[],
  };
}

// ─── awk ────────────────────────────────────────────────────────────────────

const AWK_MODES = options({
  only: `the awk is the entire response. Use for thanks, casual replies, simple confirmations, anything that needs no further work.`,
  first: `the awk is sent now, then more work happens. Use when downstream lookup, reasoning, or tools will produce the real answer.`,
  question: `the awk is a clarification question. Use when the request is too ambiguous to act on safely.`,
});

const awk: Classifier = {
  schema: z
    .object({
      text: z.string().min(1).max(280),
      mode: AWK_MODES.schema,
      should_send: z.boolean(),
      confidence: Confidence,
    })
    .strict(),
  prompt: `You generate the immediate user-facing acknowledgement (the "awk") for an inbound message.
The awk is shown to the user instantly, before any slower work happens. Keep it short and human (≤ 1 sentence, ≤ 280 chars).

Pick a mode:
${AWK_MODES.list}

Good examples:
- "Got it." (only)
- "Checking that now." (first)
- "I'll compare those and report back." (first)
- "Which Dave do you mean?" (question)
- "Done." (only)

Bad: long explanations, fake progress claims, premature conclusions, anything that sounds like the final answer when more work is still required.

"should_send" is true by default. Set false only for silent/internal channels.

${SHARED_SUFFIX}
Return: {"text": "<short response>", "mode": ${AWK_MODES.keys.map((k) => `"${k}"`).join("|")}, "should_send": true|false, "confidence": <0-1>}`,
};

// ─── response_path ──────────────────────────────────────────────────────────

const RESPONSE_PATHS = options({
  none: `no further work needed. The awk is enough, OR a clarification is pending, OR action is blocked.`,
  small_model: `a cheap model can handle it. Rewriting, short summaries, simple explanations, light formatting, low-stakes drafts.`,
  large_model: `a stronger model is justified. Complex reasoning, architecture, strategy, ambiguous planning, high-stakes writing.`,
  tool_assisted: `a tool call is needed. Web lookup, browser automation, file lookup, email/calendar action, code execution, data analysis.`,
  workflow: `route to a multi-step or durable workflow. Recurring tasks, scheduled jobs, long-running operations, multi-stage automations.`,
});

const responsePath: Classifier = {
  schema: z.object({ value: RESPONSE_PATHS.schema, confidence: Confidence }).strict(),
  prompt: `Decide what (if anything) should happen after the instant awk.

${RESPONSE_PATHS.list}

Default to the cheapest path that gets the job done. Only escalate when quality risk justifies cost.

${SHARED_SUFFIX}
Return: {"value": "<one of the values>", "confidence": <0-1>}`,
  displayOptions: RESPONSE_PATHS.keys,
};

// ─── context_budget ─────────────────────────────────────────────────────────

const CONTEXT_BUDGETS = options({
  none: `no extra context needed. Trivial acknowledgements, fully self-contained questions.`,
  current_message_only: `just this message. Default for cost control unless context is clearly needed.`,
  last_exchange: `this message + the immediately previous user/assistant turn. Use for short follow-ups like "make that shorter" or "do the second one".`,
  recent_context: `a limited recent window. Use when the message refers to a nearby discussion but doesn't need the whole conversation.`,
  retrieved_context_only: `skip conversation history; pull relevant memory/files/web/system context instead. Use when the user references known external material.`,
  full_conversation: `the entire conversation, possibly compressed. Use sparingly — most expensive option, only when the user explicitly asks to synthesize across the whole discussion.`,
});

const contextBudget: Classifier = {
  schema: z.object({ value: CONTEXT_BUDGETS.schema, confidence: Confidence }).strict(),
  prompt: `Decide how much context downstream should receive.

${CONTEXT_BUDGETS.list}

Default to "current_message_only" unless the message clearly depends on prior context.

${SHARED_SUFFIX}
Return: {"value": "<one of the values>", "confidence": <0-1>}`,
  displayOptions: CONTEXT_BUDGETS.keys,
};

// ─── retrieval_need ─────────────────────────────────────────────────────────

const RETRIEVAL_NEEDS = options({
  none: `no retrieval needed.`,
  memory: `user/long-term assistant memory ("use my usual style", "remember my setup").`,
  files: `uploaded docs, PDFs, spreadsheets, transcripts, internal file stores.`,
  web: `public internet lookup — current facts, recent events, prices, schedules, docs.`,
  browser: `interactive browser automation (operating a website/app, not just reading public pages).`,
  email_calendar: `email, calendar, contacts, scheduling, messaging.`,
  system_local_state: `local machine, shell, server, app config, logs, device state.`,
  other: `fallback for retrieval that doesn't fit cleanly.`,
});

const retrievalNeed: Classifier = {
  schema: z
    .object({
      value: z.array(RETRIEVAL_NEEDS.schema).min(1),
      confidence: Confidence,
    })
    .strict(),
  prompt: `Decide what outside information, if any, must be fetched. Return a list (one or more values).

${RETRIEVAL_NEEDS.list}

If a request needs multiple sources (e.g. compare web pricing to a spreadsheet), return all that apply. If none, return ["none"].

${SHARED_SUFFIX}
Return: {"value": ["<value1>", "<value2>", ...], "confidence": <0-1>}`,
  displayOptions: RETRIEVAL_NEEDS.keys,
};

// ─── work_complexity ────────────────────────────────────────────────────────

const WORK_COMPLEXITIES = options({
  trivial: `no real downstream reasoning. "Thanks", "ok", "yes", "got it".`,
  simple: `cheap model or direct logic suffices. Rewrite a sentence, format text, summarize a short passage, basic factual answer.`,
  moderate: `some reasoning, synthesis, tool use, or careful response construction. Compare two options, summarize a doc, debug a small issue, draft a thoughtful email.`,
  complex: `deeper reasoning, planning, architecture, tradeoff analysis, higher-quality model behavior. Design a system, diagnose a hard issue, build a strategy.`,
  multi_step: `stateful execution across multiple actions, tools, checkpoints, retries, or time. "Research X and make a report", "monitor this daily", "find jobs, dedupe, draft outreach".`,
});

const workComplexity: Classifier = {
  schema: z.object({ value: WORK_COMPLEXITIES.schema, confidence: Confidence }).strict(),
  prompt: `Estimate the effort required after classification.

${WORK_COMPLEXITIES.list}

${SHARED_SUFFIX}
Return: {"value": "<one of the values>", "confidence": <0-1>}`,
  displayOptions: WORK_COMPLEXITIES.keys,
};

// ─── registry ───────────────────────────────────────────────────────────────

/**
 * The 5 classifiers the harness runs in parallel. Add or remove entries to
 * change what gets classified — every other module reads the registry.
 */
export const CLASSIFIERS = {
  awk,
  response_path: responsePath,
  context_budget: contextBudget,
  retrieval_need: retrievalNeed,
  work_complexity: workComplexity,
};

/** Identifier for one entry in {@link CLASSIFIERS}. */
export type DimensionName = keyof typeof CLASSIFIERS;

/** Tuple of registry keys, in declaration order. Iterate this instead of hardcoding the list. */
export const DIMENSION_KEYS = Object.keys(CLASSIFIERS) as DimensionName[];
