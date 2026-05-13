// A tiny dev/demo HTTP server backing the bundled UI. Two responsibilities:
//   1. Serve the static UI from `./ui` (HTML, CSS, JS).
//   2. Run a classification over Server-Sent Events at /api/classify-stream.
//
// The SSE event vocabulary the UI listens for:
//   pipeline_started        — pipeline boot, includes the classifier list
//   pipeline_phase          — coarse phase ("normalizing" / "resource_check" /
//                             "running"); useful for progress UI
//   classifier_started      — a specific classifier is now running
//   classifier_completed    — that classifier returned a model result
//   classifier_failed       — that classifier threw without being aborted
//   classifier_aborted      — early-exit short-circuit cancelled this classifier
//   classifier_timed_out    — the per-classifier timeout fired
//   pipeline_completed      — final PipelineResult payload
//   pipeline_failed         — pipeline-level error (normalization, etc.)
//
// This server is intentionally minimal — no auth, no rate limiting, binds to
// 127.0.0.1 by default. It is not meant for production.

import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { loadCatalog } from "./catalog.js";
import { CLASSIFIER_NAMES, REGISTRY, type RunClassifier } from "./classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
} from "./config.js";
import {
  DOWNSTREAM_MODEL_TIER_VALUES,
  MODEL_SPECIALIZATION_VALUES,
  SECURITY_DECISION_VALUES,
  SECURITY_RISK_LEVEL_VALUES,
  SECURITY_SIGNAL_VALUES,
} from "./enums.js";
import {
  createOllamaClassifierRunner,
  OLLAMA_CONTEXT_LENGTH,
  OLLAMA_DEFAULT_CATALOG_PATH,
  OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
  OLLAMA_MIN_TOTAL_MEMORY_BYTES,
  OLLAMA_REQUIRED_PARALLELISM,
} from "./ollama.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type { OpenClassifyInput } from "./types.js";

// Served at GET /api/enums so the UI never needs to duplicate shared enum values.
const CLASSIFIER_ENUMS = {
  downstream_model_tier: [...DOWNSTREAM_MODEL_TIER_VALUES],
  model_specialization: [...MODEL_SPECIALIZATION_VALUES],
  security_decision: [...SECURITY_DECISION_VALUES],
  security_risk_level: [...SECURITY_RISK_LEVEL_VALUES],
  security_signal: [...SECURITY_SIGNAL_VALUES],
};

const CLASSIFIER_METADATA = REGISTRY.map((classifier) => ({
  name: classifier.name,
  kind: classifier.kind,
  version: classifier.version,
  purpose: classifier.purpose,
  order: classifier.order,
  ...("tools" in classifier ? { tools: classifier.tools ?? [] } : {}),
}));

const PORT = Number(process.env.OPEN_CLASSIFY_UI_PORT ?? 4317);
const HOST = process.env.OPEN_CLASSIFY_UI_HOST ?? "127.0.0.1";
const UI_DIR = join(process.cwd(), "ui", "dist");
const OPEN_CLASSIFY_CONFIG = loadOpenClassifyConfig(undefined, {
  optional: process.env.OPEN_CLASSIFY_CONFIG === undefined,
});
const CATALOG_PATH =
  process.env.OPEN_CLASSIFY_CATALOG_PATH ??
  OPEN_CLASSIFY_CONFIG?.catalog ??
  OLLAMA_DEFAULT_CATALOG_PATH;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer((request, response) => {
  void route(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Open Classify UI running at http://${HOST}:${PORT}/`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  console.log(`[req] ${request.method} ${request.url}`);
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "POST" && url.pathname === "/api/classify-stream") {
      await classifyStream(request, response);
      console.log(`[req] ${request.method} ${request.url} stream ended in ${Date.now() - startedAt}ms`);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/enums") {
      sendJson(response, CLASSIFIER_ENUMS);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/classifiers") {
      sendJson(response, { classifiers: CLASSIFIER_METADATA });
      return;
    }

    if (request.method === "GET") {
      serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, { error: "method not allowed" }, 405);
  } catch (error) {
    console.error(`[req] ${request.method} ${request.url} failed:`, error);
    sendJson(response, { error: errorMessage(error) }, 500);
  }
}

async function classifyStream(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  // Disable Nagle so each event flushes immediately. SSE is interactive;
  // batching kills the "live" feel.
  request.socket.setNoDelay(true);

  let closed = false;
  const clientAbortController = new AbortController();
  const abortForClientClose = (): void => {
    closed = true;
    clientAbortController.abort(new Error("SSE client disconnected"));
  };
  response.on("close", () => {
    abortForClientClose();
  });
  response.on("error", () => {
    abortForClientClose();
  });

  const send = (event: string, data: unknown): void => {
    if (closed || response.writableEnded || response.destroyed) {
      console.warn(`[sse] dropped ${event} (closed=${closed} ended=${response.writableEnded})`);
      return;
    }
    const ok = response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    console.log(`[sse] -> ${event}${(data as { name?: string })?.name ? ` ${(data as { name: string }).name}` : ""}${ok ? "" : " [backpressure]"}`);
  };

  // SSE comment heartbeat. Some intermediaries (proxies, load balancers)
  // close idle connections; a tiny ping every 5s keeps the stream warm.
  // The leading `:` makes browsers ignore the line as a comment.
  const heartbeat = setInterval(() => {
    if (closed || response.writableEnded || response.destroyed) {
      return;
    }
    response.write(`: ping ${Date.now()}\n\n`);
  }, 5000);

  try {
    const input = (await readJsonBody(request)) as OpenClassifyInput;
    const baseRunner = createOllamaClassifierRunner({
      host: OPEN_CLASSIFY_CONFIG?.runner?.host,
      defaultModel: OPEN_CLASSIFY_CONFIG?.runner?.defaultModel,
      models: classifierModelsFromConfig(OPEN_CLASSIFY_CONFIG),
      options: OPEN_CLASSIFY_CONFIG?.runner?.options,
    });
    const runClassifier: RunClassifier = async (name, classifierInput, signal) => {
      send("classifier_started", { name, started_at: Date.now() });

      try {
        const result = await baseRunner(name, classifierInput, signal);
        send("classifier_completed", { name, result, completed_at: Date.now() });
        return result;
      } catch (error) {
        console.error(`[classifier] ${name} threw:`, error);
        if (signal.aborted) {
          send(isTimeoutAbort(name, signal) ? "classifier_timed_out" : "classifier_aborted", {
            name,
            reason: errorMessage(signal.reason ?? error),
            completed_at: Date.now(),
          });
        } else {
          send("classifier_failed", {
            name,
            error: errorMessage(error),
            completed_at: Date.now(),
          });
        }
        throw error;
      }
    };

    send("pipeline_started", {
      classifiers: CLASSIFIER_NAMES,
      started_at: Date.now(),
    });
    send("pipeline_phase", { phase: "normalizing" });
    send("pipeline_phase", {
      phase: "resource_check",
      required_parallelism: OLLAMA_REQUIRED_PARALLELISM,
      context_length: OLLAMA_CONTEXT_LENGTH,
      min_total_memory_bytes: OLLAMA_MIN_TOTAL_MEMORY_BYTES,
      min_available_memory_bytes: OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
    });
    send("pipeline_phase", { phase: "running" });
    const result = await classifyOpenClassifyInput(input, {
      runClassifier,
      catalog: loadCatalog(CATALOG_PATH),
      signal: clientAbortController.signal,
    });
    send("pipeline_completed", result);
  } catch (error) {
    console.error("[pipeline] failed:", error);
    send("pipeline_failed", { error: errorMessage(error) });
  } finally {
    clearInterval(heartbeat);
    closed = true;
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }
}

// Distinguishes a timeout-driven abort from a pipeline early-exit abort, so
// the UI can show the right state. We sniff the abort reason's message
// because that's the only signal the pipeline gives us — it doesn't tag
// reasons with a structured discriminator.
function isTimeoutAbort(name: string, signal: AbortSignal): boolean {
  return errorMessage(signal.reason).includes(`${name} classifier timed out`);
}

function serveStatic(pathname: string, response: ServerResponse): void {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  // Two-layer path-traversal guard: strip leading `../` segments from the
  // normalized path, then double-check the resolved file is still inside
  // UI_DIR. The redundancy is intentional — defense in depth on a static
  // file server is cheap.
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(UI_DIR, safePath);

  if (!filePath.startsWith(UI_DIR) || !existsSync(filePath)) {
    sendJson(response, { error: "not found" }, 404);
    return;
  }

  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

// 512 KiB cap matches the input contract (5,000-char message budget plus
// generous slack for history). Big enough for any legitimate
// classification request, small enough to not be a DoS vector.
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 512 * 1024) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
