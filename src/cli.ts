#!/usr/bin/env tsx
import { randomUUID } from "crypto";
import { loadConfig } from "./config.js";
import { classify } from "./classify.js";
import { computeRoute } from "./route.js";
import { buildTrace, emitTrace } from "./trace.js";
import { InputEnvelopeSchema } from "./schema.js";

function printUsage(): void {
  console.log(`
Usage:
  llm-harness classify <input> [options]

Options:
  --model <model>       Override classifier model (e.g. ollama/qwen3:8b, openai/gpt-4o-mini)
  --config <path>       Path to config file (default: ./harness.config.json)
  --trace-file <path>   Write trace to file instead of stderr
  --no-trace            Suppress trace output
  --pretty              Pretty-print output
  --help                Show this help

Examples:
  llm-harness classify "Can you look up the latest OpenAI API pricing?"
  llm-harness classify "Debug this Python function" --model openai/gpt-4o-mini
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
  if (args.model) config.classifier.model = args.model;

  const envelope = InputEnvelopeSchema.parse({
    request_id: randomUUID(),
    user_input: args.input,
  });

  const classifyResult = await classify(envelope, config.classifier);
  const routeDecision = computeRoute(classifyResult.classification, config);

  const trace = buildTrace({
    request_id: envelope.request_id,
    user_input: envelope.user_input,
    classifier_model: config.classifier.model,
    classifier_latency_ms: classifyResult.latency_ms,
    classifier_output: classifyResult.classification,
    validation_status: classifyResult.validation_status,
    route_decision: routeDecision,
    fallback_used: classifyResult.fallback_used,
  });

  if (!args.noTrace) {
    emitTrace(trace, args.traceFile ? { file: args.traceFile } : undefined);
  }

  const output = {
    classification: classifyResult.classification,
    route_decision: routeDecision,
  };

  console.log(
    args.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output)
  );
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
