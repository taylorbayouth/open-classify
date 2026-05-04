#!/usr/bin/env node
import {
  assertBaseModelPresent,
  baseModel,
  checkTotalMemory,
  commandExists,
  formatBytes,
  isOllamaReachable,
  minTotalMemoryBytes,
  printRuntimeSummary,
  run,
  startOllamaServe,
  waitForOllama,
} from "./runtime.mjs";

async function main() {
  console.log("Open Classify setup");

  if (!(await commandExists("node", ["--version"]))) {
    throw new Error("Node.js is required.");
  }
  if (!(await commandExists("npm", ["--version"]))) {
    throw new Error("npm is required.");
  }
  if (!(await commandExists("ollama", ["--version"]))) {
    throw new Error("Ollama CLI is required. Install Ollama, then rerun setup.");
  }

  const totalMemoryBytes = checkTotalMemory();
  printRuntimeSummary(totalMemoryBytes);

  console.log("Installing npm dependencies...");
  await run("npm", ["install"]);

  let ollamaChild;
  if (!(await isOllamaReachable())) {
    console.log("Starting Ollama temporarily for model checks...");
    ollamaChild = startOllamaServe();
    await waitForOllama();
  }

  try {
    await assertBaseModelPresent();
  } finally {
    if (ollamaChild !== undefined) {
      ollamaChild.kill("SIGTERM");
    }
  }

  console.log("Building project...");
  await run("npm", ["run", "build"]);

  console.log("Setup complete.");
  console.log(`If setup failed for memory: ${formatBytes(minTotalMemoryBytes)} total is required.`);
  console.log(`If setup failed for model: run "ollama pull ${baseModel}".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
