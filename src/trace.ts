/**
 * Trace construction and emission.
 *
 * The trace is the persisted record of one classification call. It deliberately
 * stores `input_hash` (SHA-256 of the user input) rather than the raw input —
 * `GET /traces` exposes traces broadly and we don't want to leak user content.
 */
import { createHash } from "crypto";
import { appendFileSync } from "fs";
import type { Trace, SubResultRecord } from "./schema.js";

/** Input to {@link buildTrace}. `user_input` is hashed; only the hash is persisted. */
export interface TraceParams {
  request_id: string;
  user_input: string;
  total_latency_ms: number;
  sub_results: SubResultRecord[];
}

/**
 * Build a {@link Trace} from one classification's outputs. Hashes `user_input`
 * with SHA-256 and stamps the current ISO timestamp.
 */
export function buildTrace(params: TraceParams): Trace {
  return {
    request_id: params.request_id,
    input_hash: createHash("sha256").update(params.user_input).digest("hex"),
    total_latency_ms: params.total_latency_ms,
    sub_results: params.sub_results,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Serialize a trace as one JSON line. Appends to `options.file` when provided
 * (the file is opened/closed each call — fine for the harness's volume), or
 * writes to stderr otherwise.
 */
export function emitTrace(trace: Trace, options?: { file?: string }): void {
  const line = JSON.stringify(trace);
  if (options?.file) {
    appendFileSync(options.file, line + "\n", "utf-8");
  } else {
    process.stderr.write(line + "\n");
  }
}
