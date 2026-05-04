#!/usr/bin/env node
import {
  assertBaseModelPresent,
  checkTotalMemory,
  commandExists,
  isOllamaReachable,
  ollamaHost,
  printRuntimeSummary,
  run,
  startOllamaServe,
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
  } else {
    console.log("Starting Ollama with OLLAMA_NUM_PARALLEL=7 and OLLAMA_MAX_LOADED_MODELS=7");
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
