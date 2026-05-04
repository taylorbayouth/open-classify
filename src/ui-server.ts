import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSIFIER_NAMES } from "./classifiers.js";
import {
  ADDITIONAL_HISTORY_NEED_VALUES,
  DOWNSTREAM_ROUTE_VALUES,
  SECURITY_POSTURE_VALUES,
  SECURITY_SIGNAL_VALUES,
  TERMINALITY_VALUES,
  TOOL_FAMILY_VALUES,
} from "./enums.js";
import {
  createOllamaClassifierRunner,
  OLLAMA_BASE_MODEL,
  OLLAMA_CONTEXT_LENGTH,
  OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
  OLLAMA_MIN_TOTAL_MEMORY_BYTES,
  OLLAMA_REQUIRED_PARALLELISM,
} from "./ollama.js";
import { classifyOpenClassifyInput } from "./pipeline.js";
import type { ClassifierName, OpenClassifyInput, RunClassifier } from "./types.js";

const PORT = Number(process.env.OPEN_CLASSIFY_UI_PORT ?? 4317);
const HOST = process.env.OPEN_CLASSIFY_UI_HOST ?? "127.0.0.1";
const UI_DIR = join(process.cwd(), "ui");

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

    if (request.method === "GET" && url.pathname === "/api/metadata") {
      sendJson(response, metadata());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/classify-stream") {
      await classifyStream(request, response);
      console.log(`[req] ${request.method} ${request.url} stream ended in ${Date.now() - startedAt}ms`);
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
  request.socket.setNoDelay(true);

  let closed = false;
  response.on("close", () => {
    closed = true;
  });
  response.on("error", () => {
    closed = true;
  });

  const send = (event: string, data: unknown): void => {
    if (closed || response.writableEnded || response.destroyed) {
      console.warn(`[sse] dropped ${event} (closed=${closed} ended=${response.writableEnded})`);
      return;
    }
    const ok = response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    console.log(`[sse] -> ${event}${(data as { name?: string })?.name ? ` ${(data as { name: string }).name}` : ""}${ok ? "" : " [backpressure]"}`);
  };

  const heartbeat = setInterval(() => {
    if (closed || response.writableEnded || response.destroyed) {
      return;
    }
    response.write(`: ping ${Date.now()}\n\n`);
  }, 5000);

  try {
    const input = (await readJsonBody(request)) as OpenClassifyInput;
    const baseRunner = createOllamaClassifierRunner();
    const runClassifier: RunClassifier = async (name, classifierInput, signal) => {
      send("classifier_started", { name, started_at: Date.now() });

      try {
        const result = await baseRunner(name, classifierInput, signal);
        send("classifier_completed", { name, result, completed_at: Date.now() });
        return result;
      } catch (error) {
        console.error(`[classifier] ${name} threw:`, error);
        if (signal.aborted && name !== "preflight") {
          send("classifier_canceled", { name, completed_at: Date.now() });
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
    const result = await classifyOpenClassifyInput(input, { runClassifier });
    send("pipeline_completed", result);
  } catch (error) {
    send("pipeline_failed", { error: errorMessage(error) });
  } finally {
    clearInterval(heartbeat);
    closed = true;
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }
}

function metadata(): unknown {
  return {
    base_model: OLLAMA_BASE_MODEL,
    ollama_context_length: OLLAMA_CONTEXT_LENGTH,
    ollama_required_parallelism: OLLAMA_REQUIRED_PARALLELISM,
    ollama_min_total_memory_bytes: OLLAMA_MIN_TOTAL_MEMORY_BYTES,
    ollama_min_available_memory_bytes: OLLAMA_MIN_AVAILABLE_MEMORY_BYTES,
    classifiers: CLASSIFIER_NAMES,
    enums: {
      terminality: TERMINALITY_VALUES,
      downstream_route: DOWNSTREAM_ROUTE_VALUES,
      additional_history_need: ADDITIONAL_HISTORY_NEED_VALUES,
      tool_family: TOOL_FAMILY_VALUES,
      security_posture: SECURITY_POSTURE_VALUES,
      security_signal: SECURITY_SIGNAL_VALUES,
    },
  };
}

function serveStatic(pathname: string, response: ServerResponse): void {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(UI_DIR, safePath);

  if (!filePath.startsWith(UI_DIR) || !existsSync(filePath)) {
    sendJson(response, { error: "not found" }, 404);
    return;
  }

  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

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

export function __filenameForUiServer(): string {
  return fileURLToPath(import.meta.url);
}
