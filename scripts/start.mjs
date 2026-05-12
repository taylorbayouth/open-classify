#!/usr/bin/env node
// Day-to-day entry point: ensure Ollama is running with the right config,
// confirm the base model is present, then build and serve the dev UI on
// http://127.0.0.1:4317/. If we started Ollama ourselves, we kill it on
// SIGINT/SIGTERM; if we attached to an existing one, we leave it alone.

import {
  assertBaseModelPresent,
  checkOllamaServerConfig,
  checkTotalMemory,
  contextLength,
  commandExists,
  isOllamaReachable,
  ollamaHost,
  requiredParallelism,
  printRuntimeSummary,
  run,
  startOllamaServe,
  stopOllamaServe,
  waitForOllama,
} from "./runtime.mjs";

async function main() {
  console.log("Starting Open Classify");

  if (!(await commandExists("ollama", ["--version"]))) {
    throw new Error("Ollama CLI is required.");
  }

  const totalMemoryBytes = checkTotalMemory();
  printRuntimeSummary(totalMemoryBytes);

  let ollamaChild;
  if (await isOllamaReachable()) {
    console.log(`Using existing Ollama server at ${ollamaHost}`);
    const missing = await checkOllamaServerConfig().catch((err) => { console.log("checkOllamaServerConfig threw:", err.message); return []; });
    console.log("checkOllamaServerConfig missing:", missing);
    if (missing.length > 0) {
      console.log(`Ollama is misconfigured (missing: ${missing.map(([k, v]) => `${k}=${v}`).join(", ")}). Restarting with correct settings...`);
      await stopOllamaServe();
      ollamaChild = startOllamaServe();
      await waitForOllama();
    }
  } else {
    console.log(`Starting Ollama with classifier runtime settings: OLLAMA_NUM_PARALLEL=${requiredParallelism}, OLLAMA_MAX_LOADED_MODELS=${requiredParallelism}, OLLAMA_CONTEXT_LENGTH=${contextLength}`);
    ollamaChild = startOllamaServe();
    await waitForOllama();
  }

  await assertBaseModelPresent();

  const stop = () => {
    if (ollamaChild !== undefined) {
      ollamaChild.kill("SIGTERM");
    }
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(143);
  });

  await run("npm", ["run", "build"]);
  console.log("Open Classify UI: http://127.0.0.1:4317/");
  await run("node", ["dist/src/ui-server.js"]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
