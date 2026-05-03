#!/usr/bin/env tsx
import { randomUUID } from "crypto";
import { loadConfig, DIMENSION_KEYS } from "./config.js";
import { classify } from "./classify.js";
import { buildTrace, emitTrace } from "./trace.js";
import { InputEnvelopeSchema, type SubResultRecord } from "./schema.js";

function printUsage(): void {
  console.log(`
Usage:
  llm-harness classify <input> [options]

Options:
  --model <model>       Override classifier model for all 5 (e.g. ollama/gemma4:e4b-it-q4_K_M)
  --config <path>       Path to config file (default: ./harness.config.json)
  --trace-file <path>   Write trace to file instead of stderr
  --no-trace            Suppress trace output
  --pretty              Pretty-print output
  --help                Show this help

Examples:
  llm-harness classify "Can you look up the latest OpenAI API pricing?"
  llm-harness classify "Thanks" --pretty
`.trim());
}

function parseArgs(argv: string[]): {
  command: string | null;
  input: string | null;
  model?: string;
  configPath?: string;
  traceFile?: string;
  noTrace: boolean;
  pretty: boolean;
} {
  const args = argv.slice(2);
  const result = {
    command: null as string | null,
    input: null as string | null,
    model: undefined as string | undefined,
    configPath: undefined as string | undefined,
    traceFile: undefined as string | undefined,
    noTrace: false,
    pretty: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("--") && result.command === null) {
      result.command = arg;
    } else if (!arg.startsWith("--") && result.input === null) {
      result.input = arg;
    } else if (arg === "--model") {
      result.model = args[++i];
    } else if (arg === "--config") {
      result.configPath = args[++i];
    } else if (arg === "--trace-file") {
      result.traceFile = args[++i];
    } else if (arg === "--no-trace") {
      result.noTrace = true;
    } else if (arg === "--pretty") {
      result.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    i++;
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.command === null || args.command === "help") {
    printUsage();
    process.exit(0);
  }

  if (args.command !== "classify") {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    process.exit(1);
  }

  if (!args.input) {
    console.error("Error: input text required");
    printUsage();
    process.exit(1);
  }

  const config = loadConfig(args.configPath);
  if (args.model) {
    DIMENSION_KEYS.forEach((k) => {
      config.classifiers[k].model = args.model!;
    });
  }

  const envelope = InputEnvelopeSchema.parse({
    request_id: randomUUID(),
    user_input: args.input,
  });

  const result = await classify(envelope, config.classifiers);

  const sub_results: SubResultRecord[] = result.sub_results.map((r) => ({
    dimension: r.dimension,
    data: r.data,
    latency_ms: r.latency_ms,
    raw_output: r.raw_output,
    prompt: r.prompt,
    model: r.model,
    validation_status: r.validation_status,
  }));

  const trace = buildTrace({
    request_id: envelope.request_id,
    user_input: envelope.user_input,
    total_latency_ms: result.total_latency_ms,
    sub_results,
  });

  if (!args.noTrace) {
    emitTrace(trace, args.traceFile ? { file: args.traceFile } : undefined);
  }

  const output = {
    request_id: envelope.request_id,
    total_latency_ms: result.total_latency_ms,
    sub_results: result.sub_results.map(({ dimension, data, latency_ms, model, validation_status }) => ({
      dimension,
      data,
      latency_ms,
      model,
      validation_status,
    })),
  };

  console.log(args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
