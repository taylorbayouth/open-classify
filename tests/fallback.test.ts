import { describe, it, expect } from "vitest";
import { SubResultSchema, TraceSchema } from "../src/schema.js";

describe("Sub-classifier failure shape", () => {
  it("accepts a sub_result with null data and a failure status", () => {
    const failed = {
      dimension: "awk",
      data: null,
      latency_ms: 1234,
      raw_output: "",
      prompt: "...",
      model: "ollama/gemma4:e4b-it-q4_K_M",
      validation_status: "classifier_failed",
    };
    expect(SubResultSchema.safeParse(failed).success).toBe(true);
  });

  it("accepts schema_error and invalid_json statuses too", () => {
    for (const status of ["schema_error", "invalid_json"]) {
      const r = {
        dimension: "response_path",
        data: null,
        latency_ms: 0,
        raw_output: "garbage",
        prompt: "...",
        model: "ollama/gemma4:e4b-it-q4_K_M",
        validation_status: status,
      };
      expect(SubResultSchema.safeParse(r).success).toBe(true);
    }
  });

  it("rejects an unknown dimension", () => {
    const r = {
      dimension: "intent",
      data: null,
      latency_ms: 0,
      raw_output: "",
      prompt: "",
      model: "x",
      validation_status: "valid",
    };
    expect(SubResultSchema.safeParse(r).success).toBe(false);
  });

  it("Trace accepts a mix of valid and failed sub_results", () => {
    const trace = {
      request_id: "abc",
      input_hash: "deadbeef",
      total_latency_ms: 800,
      sub_results: [
        {
          dimension: "awk",
          data: { text: "Got it.", mode: "only", should_send: true, confidence: 0.95 },
          latency_ms: 200,
          raw_output: "{...}",
          prompt: "...",
          model: "ollama/gemma4:e4b-it-q4_K_M",
          validation_status: "valid",
        },
        {
          dimension: "response_path",
          data: null,
          latency_ms: 150,
          raw_output: "",
          prompt: "...",
          model: "ollama/gemma4:e4b-it-q4_K_M",
          validation_status: "classifier_failed",
        },
      ],
      timestamp: new Date().toISOString(),
    };
    expect(TraceSchema.safeParse(trace).success).toBe(true);
  });
});
