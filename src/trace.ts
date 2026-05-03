import { createHash } from "crypto";
import { appendFileSync } from "fs";
import type { Trace, SubResultRecord } from "./schema.js";

export interface TraceParams {
  request_id: string;
  user_input: string;
  total_latency_ms: number;
  sub_results: SubResultRecord[];
}

export function buildTrace(params: TraceParams): Trace {
  return {
    request_id: params.request_id,
    input_hash: createHash("sha256").update(params.user_input).digest("hex"),
    total_latency_ms: params.total_latency_ms,
    sub_results: params.sub_results,
    timestamp: new Date().toISOString(),
  };
}

export function emitTrace(trace: Trace, options?: { file?: string }): void {
  const line = JSON.stringify(trace);
  if (options?.file) {
    appendFileSync(options.file, line + "\n", "utf-8");
  } else {
    process.stderr.write(line + "\n");
  }
}
