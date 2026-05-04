import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import os from "node:os";

export const baseModel = "gemma4:e4b-it-q4_K_M";
export const requiredParallelism = 7;
export const contextLength = 4096;
export const minTotalMemoryBytes = 16 * 1024 * 1024 * 1024;
export const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const execFileAsync = promisify(execFile);

export function formatBytes(value) {
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function checkTotalMemory() {
  const totalMemoryBytes = os.totalmem();
  if (totalMemoryBytes < minTotalMemoryBytes) {
    throw new Error(
      `This machine has ${formatBytes(totalMemoryBytes)} total memory; ${formatBytes(minTotalMemoryBytes)} is required for ${requiredParallelism} parallel classifiers.`,
    );
  }
  return totalMemoryBytes;
}

export async function commandExists(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

export async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

export async function isOllamaReachable() {
  try {
    await readJson(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export function startOllamaServe() {
  const child = spawn("ollama", ["serve"], {
    env: {
      ...process.env,
      OLLAMA_NUM_PARALLEL: String(requiredParallelism),
      OLLAMA_MAX_LOADED_MODELS: String(requiredParallelism),
      OLLAMA_CONTEXT_LENGTH: String(contextLength),
      OLLAMA_MAX_QUEUE: process.env.OLLAMA_MAX_QUEUE ?? "64",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`Ollama stopped by ${signal}`);
    } else if (code !== 0) {
      console.log(`Ollama exited with ${code}`);
    }
  });

  return child;
}

export async function waitForOllama(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOllamaReachable()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Ollama did not become reachable at ${ollamaHost}`);
}

export async function assertBaseModelPresent() {
  const tags = await readJson(`${ollamaHost}/api/tags`);
  const models = Array.isArray(tags.models) ? tags.models : [];
  const found = models.some((model) => model.name === baseModel || model.model === baseModel);
  if (!found) {
    throw new Error(`Missing Ollama model ${baseModel}. Run: ollama pull ${baseModel}`);
  }
}

export async function assertOllamaServerConfig() {
  if (process.platform !== "darwin") {
    return;
  }

  const { stdout } = await execFileAsync("pgrep", ["-f", "ollama serve"]);
  const pid = stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);

  if (pid === undefined) {
    throw new Error("Ollama server process was not found.");
  }

  const { stdout: envOutput } = await execFileAsync("ps", ["eww", "-p", pid]);
  const required = {
    OLLAMA_NUM_PARALLEL: String(requiredParallelism),
    OLLAMA_MAX_LOADED_MODELS: String(requiredParallelism),
    OLLAMA_CONTEXT_LENGTH: String(contextLength),
  };

  const missing = Object.entries(required).filter(
    ([key, value]) => !envOutput.includes(`${key}=${value}`),
  );

  if (missing.length > 0) {
    throw new Error(
      `Existing Ollama server is not configured for Open Classify. Stop it with "pkill -f ollama", then run "npm run start". Missing: ${missing
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
  }
}

export function printRuntimeSummary(totalMemoryBytes) {
  console.log(`Memory: ${formatBytes(totalMemoryBytes)} total`);
  console.log(`Required classifier parallelism: ${requiredParallelism}`);
  console.log(`Required Ollama context length: ${contextLength}`);
  console.log(`Ollama host: ${ollamaHost}`);
  console.log(`Base model: ${baseModel}`);
}
