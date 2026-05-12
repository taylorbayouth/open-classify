// Shared helpers for the `setup` and `start` scripts. Anything that needs to
// reason about the local Ollama server, the base model, or the runtime
// resource floor lives here so the two top-level scripts can stay tiny.

import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import os from "node:os";

export const baseModel = "gemma4:e4b-it-q4_K_M";
export const baseModelNativeContextLength = 131_072;
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

// Launch `ollama serve` with the env vars Open Classify needs. Critically,
// `OLLAMA_NUM_PARALLEL` must be high enough to actually run all classifiers
// concurrently — without this, requests serialize and the whole pipeline
// stalls on the slowest one. The classifier count, parallelism, and loaded-
// model cap are deliberately the same number.
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

// If a user already has Ollama running, we don't want to silently inherit a
// server that wasn't started with the right env vars (it'd serialize our
// requests). On macOS we can read the running process's environment via
// `ps eww` and verify; on other platforms we skip the check rather than
// guess. If you're on Linux/Windows and want the same protection, this is
// the place to extend.

// Returns the list of missing [key, value] pairs. Empty array means OK.
export async function checkOllamaServerConfig() {
  if (process.platform !== "darwin") {
    return [];
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync("pgrep", ["-f", "ollama serve"]));
  } catch (error) {
    // pgrep exits with code 1 when no matching process is found.
    if (error?.code === 1) {
      throw new Error("Ollama server process was not found.");
    }
    throw error;
  }

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

  return Object.entries(required).filter(
    ([key, value]) => !envOutput.includes(`${key}=${value}`),
  );
}

export async function assertOllamaServerConfig() {
  const missing = await checkOllamaServerConfig();
  if (missing.length > 0) {
    throw new Error(
      `Existing Ollama server is not configured for Open Classify. Stop it with "pkill -f ollama", then run "npm run start". Missing: ${missing
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`,
    );
  }
}

// Stop the running `ollama serve` process and wait for the port to clear.
export async function stopOllamaServe() {
  await execFileAsync("pkill", ["-f", "ollama serve"]).catch(() => {});
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!(await isOllamaReachable())) return;
    await delay(500);
  }
}

export function printRuntimeSummary(totalMemoryBytes) {
  console.log(`Memory: ${formatBytes(totalMemoryBytes)} total`);
  console.log(`Required classifier parallelism: ${requiredParallelism}`);
  console.log(`Base model native context length: ${baseModelNativeContextLength}`);
  console.log(`Configured classifier context length: ${contextLength}`);
  console.log(`Ollama host: ${ollamaHost}`);
  console.log(`Base model: ${baseModel}`);
}
