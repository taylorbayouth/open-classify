import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildClassifierRegistry } from "../dist/src/classifiers.js";
import {
  classifierModelsFromConfig,
  loadOpenClassifyConfig,
  OpenClassifyConfigError,
  validateOpenClassifyConfig,
} from "../dist/src/config.js";
import { createClassifier } from "../dist/src/classify.js";
import {
  createOllamaClassifierRunner,
  OllamaClassifierError,
  OllamaResourceError,
  OLLAMA_BASE_MODEL,
  OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH,
  OLLAMA_CONTEXT_LENGTH,
  OLLAMA_DEFAULT_HOST,
} from "../dist/src/ollama.js";
import {
  classifierInput,
  jsonResponse,
  templateAsExtra,
  TEST_CATALOG,
  validClassifierOutputs as validOutputs,
} from "./fixtures.mjs";

// The Ollama runner tests exercise classifier-specific validation paths
// (including for `tools`, `memory_retrieval_queries`, `conversation_digest`,
// `context_shift` — the four templates), so the runner's module map needs
// every classifier available. Templates aren't loaded from the package by
// default; we enable them by passing them as extras, same as consumers.
const REGISTRY = buildClassifierRegistry({
  extraDirs: [
    templateAsExtra("tools"),
    templateAsExtra("memory_retrieval_queries"),
    templateAsExtra("conversation_digest"),
    templateAsExtra("context_shift"),
  ],
});
const MODULES_BY_NAME = REGISTRY.modulesByName;

function makeRunner(config) {
  return createOllamaClassifierRunner({ modulesByName: MODULES_BY_NAME, ...config });
}

test("exports Ollama default runtime identity", () => {
  assert.equal(OLLAMA_DEFAULT_HOST, "http://localhost:11434");
  assert.equal(OLLAMA_BASE_MODEL, "gemma4:e4b-it-q4_K_M");
  assert.equal(OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH, 131_072);
  assert.equal(OLLAMA_CONTEXT_LENGTH, 4096);
});

test("createOllamaClassifierRunner posts classifier chat request with model override", async () => {
  const calls = [];
  const runner = makeRunner({
    host: "http://ollama.test/",
    models: { preflight: "custom-preflight" },
    skipResourceCheck: true,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  const signal = new AbortController().signal;
  const result = await runner(
    "preflight",
    classifierInput(),
    signal,
  );

  assert.deepEqual(result, validOutputs.preflight);
  assert.equal(calls[0].url, "http://ollama.test/api/chat");
  assert.equal(calls[0].init.signal, signal);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "custom-preflight");
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.equal(body.options.temperature, 0);
  assert.equal(body.options.num_ctx, OLLAMA_CONTEXT_LENGTH);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /Classifier: preflight/);
  assert.match(body.messages[0].content, /final_reply/);
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /The target user message is the final message in the window\./);
  assert.match(body.messages[1].content, /Message 1 \(target\):/);
  assert.match(body.messages[1].content, /text:\nhello/);
  assert.doesNotMatch(body.messages[1].content, /target_message_hash/);
});

test("createOllamaClassifierRunner drops older whole messages to fit estimated context", async () => {
  const calls = [];
  const runner = makeRunner({
    skipResourceCheck: true,
    options: { num_ctx: 1500 },
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await runner(
    "preflight",
    classifierInput({
      text: "final request",
      messages: [
        { role: "user", text: `older context ${"x".repeat(4000)}` },
        { role: "user", text: "final request" },
      ],
    }),
    new AbortController().signal,
  );

  const prompt = calls[0].messages[1].content;
  assert.doesNotMatch(prompt, /older context/);
  assert.match(prompt, /Message 1 \(target\):/);
  assert.match(prompt, /text:\nfinal request/);
});

test("createOllamaClassifierRunner rejects when target alone exceeds estimated context", async () => {
  let called = false;
  const runner = makeRunner({
    skipResourceCheck: true,
    options: { num_ctx: 1000 },
    fetch: async () => {
      called = true;
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await assert.rejects(
    runner(
      "preflight",
      classifierInput({
        text: "x".repeat(10_000),
        messages: [{ role: "user", text: "x".repeat(10_000) }],
      }),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /target message/.test(error.message),
  );
  assert.equal(called, false);
});

test("createOllamaClassifierRunner uses base model when classifier model is null", async () => {
  const calls = [];
  const runner = makeRunner({
    models: { preflight: null },
    skipResourceCheck: true,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await runner("preflight", classifierInput(), new AbortController().signal);

  assert.equal(calls[0].model, OLLAMA_BASE_MODEL);
});

test("createOllamaClassifierRunner accepts a configured default model", async () => {
  const calls = [];
  const runner = makeRunner({
    defaultModel: "configured-default",
    skipResourceCheck: true,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await runner("preflight", classifierInput(), new AbortController().signal);

  assert.equal(calls[0].model, "configured-default");
});

test("loadOpenClassifyConfig validates the flat per-classifier model map", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-"));
  const path = join(dir, "open-classify.config.json");
  writeFileSync(path, JSON.stringify({
    runner: {
      provider: "ollama",
      defaultModel: "default-model",
      models: {
        preflight: "tier-a",
        memory_retrieval_queries: "tier-b",
      },
    },
    catalog: "downstream-models.json",
  }));

  const config = loadOpenClassifyConfig(path);

  assert.equal(config.runner.defaultModel, "default-model");
  assert.deepEqual(classifierModelsFromConfig(config), {
    preflight: "tier-a",
    memory_retrieval_queries: "tier-b",
  });
});

test("loadOpenClassifyConfig rejects aggregator field (removed)", () => {
  assert.throws(
    () => validateOpenClassifyConfig({ aggregator: { certaintyThreshold: 0.65 } }),
    (error) =>
      error instanceof OpenClassifyConfigError &&
      /aggregator is not a supported field/.test(error.message),
  );
});

test("loadOpenClassifyConfig rejects unknown stock classifiers", () => {
  assert.throws(
    () => validateOpenClassifyConfig({ classifiers: { stock: ["definitely_not_real"] } }),
    (error) =>
      error instanceof OpenClassifyConfigError &&
      /classifiers\.stock\[0\] "definitely_not_real" is not supported/.test(error.message),
  );
});

test("createClassifier rejects config models that name unknown classifiers", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-"));
  const path = join(dir, "open-classify.config.json");
  writeFileSync(path, JSON.stringify({
    runner: {
      provider: "ollama",
      models: { definitely_not_real: "model" },
    },
  }));

  assert.throws(
    () =>
      createClassifier({
        configPath: path,
        skipResourceCheck: true,
        catalog: TEST_CATALOG,
      }),
    (error) =>
      error instanceof OpenClassifyConfigError &&
      /definitely_not_real is not a loaded classifier/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects unknown preflight fields", async () => {
  const runner = runnerReturning({
    reason: "Invalid.",
    certainty: "strong",
    handoff: { kind: "final", reply: "Nope." },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /handoff is not a supported field/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates preflight reply length", async () => {
  const runner = runnerReturning({
    reason: "Too long.",
    certainty: "strong",
    ack_reply: { text: "x".repeat(201) },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /must NOT have more than 200 characters/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects empty preflight replies", async () => {
  const runner = runnerReturning({
    reason: "Empty.",
    certainty: "strong",
    ack_reply: { text: "   " },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /must match pattern|text/i.test(error.message),
  );
});

test("createOllamaClassifierRunner validates model_tier enum values", async () => {
  const runner = runnerReturning({
    reason: "Invalid tier.",
    certainty: "tentative",
    model_tier: "ultra_strong",
  });

  await assert.rejects(
    runner("model_tier", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "model_tier" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates memory custom output schema", async () => {
  const runner = runnerReturning({
    reason: "Bad query.",
    certainty: "tentative",
    queries: [""],
  });

  await assert.rejects(
    runner("memory_retrieval_queries", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "memory_retrieval_queries" &&
      /must NOT have fewer than 1 characters/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects duplicate tools", async () => {
  const runner = runnerReturning({
    reason: "Duplicate.",
    certainty: "tentative",
    tools: ["workspace", "workspace"],
  });

  await assert.rejects(
    runner("tools", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "tools" &&
      /uniqueItems|duplicate/i.test(error.message),
  );
});

test("tools system prompt describes empty tools as no tools required", () => {
  assert.match(
    MODULES_BY_NAME.tools.systemPrompt,
    /An empty array means no downstream tools are required/,
  );
});

test("createOllamaClassifierRunner validates model_specialization enum", async () => {
  const runner = runnerReturning({
    reason: "Invalid spec.",
    certainty: "tentative",
    model_specialization: "spreadsheet_magic",
  });

  await assert.rejects(
    runner("model_specialization", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "model_specialization" &&
      /unsupported value|model_specialization/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects prompt_injection signals field", async () => {
  const runner = runnerReturning({
    reason: "Conflicting.",
    certainty: "tentative",
    risk_level: "normal",
    signals: ["instruction_attack"],
  });

  await assert.rejects(
    runner("prompt_injection", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "prompt_injection" &&
      /signals/.test(error.message),
  );
});

test("createOllamaClassifierRunner surfaces non-JSON model output", async () => {
  const runner = makeRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({ message: { content: "this is not json" } }),
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight",
  );
});

test("createOllamaClassifierRunner accepts fenced JSON model output", async () => {
  const runner = makeRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: {
          content: `\`\`\`json
${JSON.stringify(validOutputs.preflight, null, 2)}
\`\`\``,
        },
      }),
  });

  assert.deepEqual(
    await runner("preflight", classifierInput(), new AbortController().signal),
    validOutputs.preflight,
  );
});

test("createOllamaClassifierRunner surfaces Ollama HTTP errors", async () => {
  const runner = makeRunner({
    skipResourceCheck: true,
    fetch: async () => jsonResponse({ error: "model not found" }, { ok: false, statusText: "Not Found" }),
  });

  await assert.rejects(
    runner("prompt_injection", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "prompt_injection" &&
      /model not found/.test(error.message),
  );
});

test("createClassifier wires the Ollama runner into the pipeline", async () => {
  const { classify } = createClassifier({
    skipResourceCheck: true,
    catalog: TEST_CATALOG,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(typeof body.model === "string" && body.model.length > 0);
      const systemPrompt = body.messages[0].content;
      const entries = Object.entries(MODULES_BY_NAME);
      const match = entries.find(([, module]) => module.systemPrompt === systemPrompt);
      assert.ok(match, "system prompt should match a registered module");
      const [name] = match;

      assert.match(body.messages[1].content, /text:\nreview this/);

      return jsonResponse({
        message: { content: JSON.stringify(validOutputs[name]) },
      });
    },
  });

  const result = await classify({
    messages: [{ role: "user", text: "review this" }],
  });

  assert.equal(result.action, "route");
  assert.match(result.target_message_hash, /^[a-f0-9]{8}$/);
  assert.deepEqual(result.failed_classifiers, []);
  // reasoning + local_strong → gemma4.
  assert.equal(result.model_id, "gemma4:e4b-it-q4_K_M");
  assert.deepEqual(result.prompt_injection, { risk_level: "normal" });
  assert.deepEqual(result.reply, { text: "Let me check." });
});

test("createClassifier reuses the runner and catalog across calls", async () => {
  let fetchCount = 0;
  const { classify } = createClassifier({
    skipResourceCheck: true,
    catalog: TEST_CATALOG,
    fetch: async (_url, init) => {
      fetchCount += 1;
      const body = JSON.parse(init.body);
      const [name] = Object.entries(MODULES_BY_NAME)
        .find(([, module]) => module.systemPrompt === body.messages[0].content);
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs[name]) },
      });
    },
  });

  const first = await classify({ messages: [{ role: "user", text: "one" }] });
  const callsAfterFirst = fetchCount;
  const second = await classify({ messages: [{ role: "user", text: "two" }] });

  assert.equal(first.action, "route");
  assert.equal(second.action, "route");
  // Each classify() call should issue one fetch per classifier, with no
  // re-initialization overhead beyond that.
  assert.equal(fetchCount, callsAfterFirst * 2);
});

test("createClassifier picks up models from the config file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "open-classify-"));
  const path = join(dir, "open-classify.config.json");
  writeFileSync(path, JSON.stringify({
    runner: {
      provider: "ollama",
      defaultModel: "config-default",
      models: { preflight: "config-preflight" },
    },
  }));

  const seenModels = new Set();
  const { classify } = createClassifier({
    configPath: path,
    skipResourceCheck: true,
    catalog: TEST_CATALOG,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      seenModels.add(body.model);
      const systemPrompt = body.messages[0].content;
      const [name] = Object.entries(MODULES_BY_NAME)
        .find(([, module]) => module.systemPrompt === systemPrompt);
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs[name]) },
      });
    },
  });

  const result = await classify({
    messages: [{ role: "user", text: "review this" }],
  });

  assert.ok(seenModels.has("config-preflight"));
  assert.ok(seenModels.has("config-default"));
  assert.equal(result.action, "route");
  assert.deepEqual(result.failed_classifiers, []);
});

test("resource check can fail before fetch is called", async () => {
  let called = false;
  const runner = makeRunner({
    minTotalMemoryBytes: Number.MAX_SAFE_INTEGER,
    minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER,
    fetch: async () => {
      called = true;
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    OllamaResourceError,
  );
  assert.equal(called, false);
});

test("createClassifier surfaces resource failures instead of returning fallbacks", async () => {
  let called = false;
  const { classify } = createClassifier({
    catalog: TEST_CATALOG,
    minTotalMemoryBytes: Number.MAX_SAFE_INTEGER,
    minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER,
    fetch: async () => {
      called = true;
      return jsonResponse({
        message: { content: JSON.stringify(validOutputs.preflight) },
      });
    },
  });

  await assert.rejects(
    classify({ messages: [{ role: "user", text: "review this" }] }),
    OllamaResourceError,
  );

  assert.equal(called, false);
});

test("createClassifier accepts a custom RunClassifier and bypasses Ollama", async () => {
  const seen = [];
  const fakeRunner = async (name, _input, _signal) => {
    seen.push(name);
    return validOutputs[name];
  };

  const { classify } = createClassifier({
    runClassifier: fakeRunner,
    catalog: TEST_CATALOG,
  });

  const result = await classify({
    messages: [{ role: "user", text: "review this" }],
  });

  assert.equal(result.action, "route");
  // Only the four mandatory built-ins run by default; templates aren't
  // loaded unless added via extraClassifierDirs.
  const mandatory = ["preflight", "model_tier", "model_specialization", "prompt_injection"];
  for (const name of mandatory) {
    assert.ok(seen.includes(name), `runner should have been called for ${name}`);
  }
  for (const template of ["tools", "memory_retrieval_queries", "conversation_digest", "context_shift"]) {
    assert.equal(seen.includes(template), false, `${template} is a template, not a default-loaded built-in`);
  }
});

function runnerReturning(payload) {
  return makeRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({ message: { content: JSON.stringify(payload) } }),
  });
}
