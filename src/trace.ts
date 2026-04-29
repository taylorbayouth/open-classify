import { createHash } from "crypto";
import { appendFileSync } from "fs";
import type { Classification, RouteDecision, Trace, ValidationStatus } from "./schema.js";

export interface TraceParams {
  request_id: string;
  user_input: string;
  classifier_model: string;
  classifier_latency_ms: number;
  classifier_output: Classification | null;
  validation_status: ValidationStatus;
  route_decision: RouteDecision;
  fallback_used: boolean;
}

export function buildTrace(params: TraceParams): Trace {
  return {
    request_id: params.request_id,
    input_hash: createHash("sha256").update(params.user_input).digest("hex"),
    classifier_model: params.classifier_model,
    classifier_latency_ms: params.classifier_latency_ms,
    classifier_output: params.classifier_output,
    validation_status: params.validation_status,
    route_decision: params.route_decision,
    fallback_used: params.fallback_used,
    timestamp: new Date().toISOString(),
  };
}

export function emitTrace(trace: Trace, options?: { file?: string }): void {
  const line = JSON.stringify(trace);
  if (options?.file) {
    appendFileSync(options.file, line + "\n", "utf-8");
  } else {
    // Write to stderr so stdout stays clean for CLI output
    process.stderr.write(line + "\n");
  }
}
