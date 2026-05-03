/**
 * Cross-cutting schemas — the shapes that don't belong to any one classifier.
 *
 * Per-classifier result schemas live with their prompt in {@link ../classifiers},
 * so adding a new dimension is one edit in one file.
 */
import { z } from "zod";
import { DIMENSION_KEYS, type DimensionName } from "./classifiers.js";

export type { DimensionName };

/**
 * Outcome of a single sub-classifier call.
 *
 * - `valid` — the model returned JSON that parsed against the dimension's schema.
 * - `invalid_json` — the response was not parseable JSON (or no `{...}` block could be extracted).
 * - `schema_error` — the JSON parsed but did not match the dimension schema.
 * - `classifier_failed` — the call threw, timed out, or was aborted.
 */
export const ValidationStatus = z.enum([
  "valid",
  "invalid_json",
  "schema_error",
  "classifier_failed",
]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/**
 * Sanitizes a raw user-provided string before it reaches any classifier.
 * Idempotent and non-destructive: never changes the semantic content of the
 * message. Steps, in order:
 *
 *   1. Strip a leading byte-order mark (U+FEFF). Common when text is pasted
 *      from editors that prepend one.
 *   2. Unicode NFC normalization (composed form — web canonical). Without
 *      this, visually identical strings can hash differently.
 *   3. Strip ASCII control chars except `\t`, `\n`, `\r`. NUL, BEL, etc.
 *      have no place in user prompts and break JSON/log pipelines.
 *   4. Trim outer whitespace.
 *
 * Note: there is intentionally NO upper length bound here. The library does
 * not decide how long a caller's input may be — that is the caller's choice
 * (and ultimately, the model's context window). The HTTP server applies a
 * separate byte-level cap (`server.max_body_bytes`) as a deployment-level
 * DoS guard, but the library/CLI/direct-API path is uncapped.
 *
 * Empty-after-sanitization is rejected by {@link InputEnvelopeSchema} below,
 * because every classifier needs at least one character to classify.
 */
export function sanitizeUserInput(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.normalize("NFC");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  s = s.trim();
  return s;
}

/**
 * What gets handed to {@link classify}: the user's message plus a
 * caller-provided `request_id` for trace correlation. Optional state and
 * metadata are accepted but currently unused — they exist as forward-compatible
 * hooks for future routing logic.
 *
 * `user_input` is sanitized at parse time (BOM strip, NFC, control-char strip,
 * trim). The only length-related rule is "must not be empty after
 * sanitization" — there is no upper bound. Callers who want one can layer it
 * on themselves before calling `parse`.
 */
export const InputEnvelopeSchema = z.object({
  request_id: z.string().min(1),
  user_input: z
    .string()
    .transform(sanitizeUserInput)
    .refine((s) => s.length > 0, {
      message: "user_input is empty after sanitization",
    }),
  state_capsule: z.unknown().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

/**
 * One sub-classifier's full record — the canonical shape that flows through
 * the streaming endpoint, the trace, and the UI. `data` is the parsed model
 * output (one of the per-dimension result shapes) when
 * `validation_status === "valid"`, and `null` otherwise. `raw_output` is
 * always preserved (including model `<think>` blocks) so failures stay
 * debuggable.
 */
export const SubResultSchema = z.object({
  dimension: z.enum(DIMENSION_KEYS as [DimensionName, ...DimensionName[]]),
  data: z.unknown().nullable(),
  latency_ms: z.number(),
  raw_output: z.string(),
  prompt: z.string(),
  model: z.string(),
  validation_status: ValidationStatus,
});
export type SubResultRecord = z.infer<typeof SubResultSchema>;

/**
 * A {@link SubResultRecord} tagged for transport over the streaming endpoint.
 * The `type` discriminator lets clients distinguish sub-results from `started`
 * / `complete` envelope frames in the NDJSON stream.
 */
export type SubResultEvent = SubResultRecord & { type: "sub_result" };

/**
 * Persisted classification trace. Note that `input_hash` (SHA-256 of the user
 * input) is stored deliberately in place of the raw input — `GET /traces`
 * exposes traces broadly, and we don't want to leak user content.
 */
export const TraceSchema = z.object({
  request_id: z.string(),
  input_hash: z.string(),
  total_latency_ms: z.number(),
  sub_results: z.array(SubResultSchema),
  timestamp: z.string(),
});
export type Trace = z.infer<typeof TraceSchema>;
