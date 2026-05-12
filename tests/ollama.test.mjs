import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MODULES_BY_NAME } from "../dist/src/classifiers.js";
import {
  classifyWithOllama,
  createOllamaClassifierRunner,
  discoverOllamaClassifierAdapterModels,
  OllamaClassifierError,
  OllamaResourceError,
  OLLAMA_DEFAULT_ADAPTER_MODEL_CONFIG,
  OLLAMA_CLASSIFIER_ADAPTER_MODELS,
  OLLAMA_BASE_MODEL,
  OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH,
  OLLAMA_CLASSIFIER_MODELS,
  OLLAMA_CONTEXT_LENGTH,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_REQUIRED_PARALLELISM,
} from "../dist/src/ollama.js";
import {
  classifierInput,
  jsonResponse,
  TEST_CATALOG,
  validClassifierOutputs as validOutputs,
} from "./fixtures.mjs";

test("exports Ollama default runtime identity", () => {
  assert.equal(OLLAMA_DEFAULT_HOST, "http://localhost:11434");
  assert.equal(OLLAMA_BASE_MODEL, "gemma4:e4b-it-q4_K_M");
  assert.equal(OLLAMA_BASE_MODEL_NATIVE_CONTEXT_LENGTH, 131_072);
  assert.equal(OLLAMA_REQUIRED_PARALLELISM, 7);
  assert.equal(OLLAMA_CONTEXT_LENGTH, 4096);
  assert.equal(OLLAMA_DEFAULT_ADAPTER_MODEL_CONFIG, "adapter-models.json");
  assert.equal(OLLAMA_CLASSIFIER_MODELS.preflight, null);
  assert.equal(OLLAMA_CLASSIFIER_ADAPTER_MODELS.preflight, null);
  assert.equal(OLLAMA_CLASSIFIER_ADAPTER_MODELS.model_specialization, null);
});

test("discovers classifier model overrides from JSON config incrementally", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-classify-adapters-"));
  const configPath = join(root, "adapter-models.json");
  try {
    await writeFile(configPath, JSON.stringify({
      preflight: "open-classify-preflight:v0.1.0",
      security: null,
    }));

    const models = discoverOllamaClassifierAdapterModels(configPath);

    assert.equal(models.preflight, "open-classify-preflight:v0.1.0");
    assert.equal(models.security, null);
    assert.equal(models.routing, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createOllamaClassifierRunner uses base model for missing adapter config entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-classify-adapters-"));
  const configPath = join(root, "adapter-models.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({ preflight: "open-classify-preflight:v0.1.0" }),
    );

    const calls = [];
    const runner = createOllamaClassifierRunner({
      adapterModelConfig: configPath,
      skipResourceCheck: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        return jsonResponse({
          message: {
            content: JSON.stringify(
              body.model === "open-classify-preflight:v0.1.0"
                ? validOutputs.preflight
                : validOutputs.routing,
            ),
          },
        });
      },
    });

    await runner("preflight", classifierInput(), new AbortController().signal);
    await runner("routing", classifierInput(), new AbortController().signal);

    assert.equal(calls[0].model, "open-classify-preflight:v0.1.0");
    assert.equal(calls[1].model, OLLAMA_BASE_MODEL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createOllamaClassifierRunner posts classifier chat request with model override", async () => {
  const calls = [];
  const runner = createOllamaClassifierRunner({
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
    classifierInput({
      attachments: [
        { filename: "Welcome.md", mime_type: "text/markdown", size_bytes: 203 },
      ],
    }),
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
  assert.match(body.messages[0].content, /confidence: JSON number float from 0\.0 to 1\.0 inclusive/);
  assert.match(body.messages[0].content, /Declared optional fields: handoff\./);
  assert.match(body.messages[0].content, /preflight classifier/);
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /The target user message is the final message in the window\./);
  assert.match(body.messages[1].content, /Message 1 \(target\):/);
  assert.match(body.messages[1].content, /text:\nhello/);
  assert.match(body.messages[1].content, /filename: Welcome\.md/);
  assert.match(body.messages[1].content, /mime_type: text\/markdown/);
  assert.match(body.messages[1].content, /size_bytes: 203/);
  assert.doesNotMatch(body.messages[1].content, /target_message_hash/);
});

test("createOllamaClassifierRunner drops older whole messages to fit estimated context", async () => {
  const calls = [];
  const runner = createOllamaClassifierRunner({
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
  const runner = createOllamaClassifierRunner({
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

test("createOllamaClassifierRunner uses base model for null adapter", async () => {
  const calls = [];
  const runner = createOllamaClassifierRunner({
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

test("createOllamaClassifierRunner validates preflight handoff kind", async () => {
  const runner = runnerReturning({
    reason: "Invalid terminality.",
    confidence: 0.7,
    handoff: { kind: "bad", reply: "Nope." },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates preflight reply length", async () => {
  const runner = runnerReturning({
    reason: "The reply is intentionally too long.",
    confidence: 0.7,
    handoff: { kind: "route", ack_reply: "x".repeat(201) },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /reply must be 200 characters or fewer/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects empty preflight replies", async () => {
  const runner = runnerReturning({
    reason: "The reply is intentionally empty.",
    confidence: 0.7,
    handoff: { kind: "route", ack_reply: "   " },
  });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /reply must not be empty/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates routing enum values", async () => {
  const runner = runnerReturning({
    reason: "Invalid model tier.",
    confidence: 0.5,
    routing: { execution_mode: "tool_assisted", model_tier: "ultra_strong" },
  });

  await assert.rejects(
    runner("routing", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "routing" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates conversation_history context shape", async () => {
  const runner = runnerReturning({
    reason: "The latest message refers to visible history.",
    confidence: 0.6,
    context: { status: "sufficient" },
  });

  await assert.rejects(
    runner("conversation_history", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "conversation_history" &&
      /include_prior_messages/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates conversation_history exact keys", async () => {
  const runner = runnerReturning({
    reason: "The latest message can be handled without prior messages.",
    confidence: 0.9,
    context: { status: "standalone" },
    extra: true,
  });

  await assert.rejects(
    runner("conversation_history", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "conversation_history" &&
      /not declared in emits/.test(error.message),
  );
});

test("createOllamaClassifierRunner drops irrelevant include_prior_messages", async () => {
  const runner = runnerReturning({
    reason: "The latest message refers to visible history.",
    confidence: 0.5,
    context: { status: "standalone", include_prior_messages: 1 },
  });

  assert.deepEqual(
    await runner("conversation_history", classifierInput(), new AbortController().signal),
    {
      reason: "The latest message refers to visible history.",
      confidence: 0.5,
      context: { status: "standalone" },
    },
  );
});

test("createOllamaClassifierRunner validates memory custom output schema", async () => {
  const runner = runnerReturning({
    reason: "The query is intentionally invalid.",
    confidence: 0.5,
    output: { queries: [""] },
  });

  await assert.rejects(
    runner("memory_retrieval_queries", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "memory_retrieval_queries" &&
      /must NOT have fewer than 1 characters/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects duplicate tool families", async () => {
  const runner = runnerReturning({
    reason: "The families are intentionally duplicated.",
    confidence: 0.5,
    tools: { required: true, families: ["workspace", "workspace"] },
  });

  await assert.rejects(
    runner("tools", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "tools" &&
      /must not include duplicates/.test(error.message),
  );
});

test("tools system prompt keeps needed aligned with families", () => {
  assert.match(
    MODULES_BY_NAME.tools.systemPrompt,
    /tools\.required must be true exactly when tools\.families is non-empty/,
  );
});

test("createOllamaClassifierRunner validates model_specialization enum", async () => {
  const runner = runnerReturning({
    reason: "Invalid specialization.",
    confidence: 0.5,
    routing: { specialization: "spreadsheet_magic" },
  });

  await assert.rejects(
    runner("model_specialization", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "model_specialization" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates security risk-level / signals consistency", async () => {
  const runner = runnerReturning({
    reason: "Conflicting output.",
    confidence: 0.5,
    safety: { risk_level: "normal", signals: ["instruction_attack"] },
  });

  await assert.rejects(
    runner("security", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "security" &&
      /normal safety.risk_level must not include signals/.test(error.message),
  );
});

test("createOllamaClassifierRunner surfaces non-JSON model output", async () => {
  const runner = createOllamaClassifierRunner({
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
  const runner = createOllamaClassifierRunner({
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
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () => jsonResponse({ error: "model not found" }, { ok: false, statusText: "Not Found" }),
  });

  await assert.rejects(
    runner("security", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "security" &&
      /model not found/.test(error.message),
  );
});

test("classifyWithOllama uses the Ollama runner in the pipeline", async () => {
  const result = await classifyWithOllama(
    { messages: [{ role: "user", text: "review this" }] },
    {
      skipResourceCheck: true,
      catalog: TEST_CATALOG,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.ok(typeof body.model === "string" && body.model.length > 0);
        const systemPrompt = body.messages[0].content;
        // Identify which classifier was invoked by matching generated system
        // prompts back to the registered modules.
        const entries = Object.entries(MODULES_BY_NAME);
        const match = entries.find(([, module]) => module.systemPrompt === systemPrompt);
        assert.ok(match, "system prompt should match a registered module");
        const [name] = match;

        assert.match(body.messages[1].content, /text:\nreview this/);
        assert.doesNotMatch(body.messages[1].content, /"text"/);
        assert.doesNotMatch(body.messages[1].content, /"raw"/);

        return jsonResponse({
          message: { content: JSON.stringify(validOutputs[name]) },
        });
      },
    },
  );

  assert.equal(result.decision, "route");
  assert.match(result.target_message_hash, /^[a-f0-9]{8}$/);
  for (const [name, expected] of Object.entries(validOutputs)) {
    const entry = result.meta.classifiers[name];
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(entry[field], value, `meta.classifiers.${name}.${field}`);
    }
    assert.equal(entry.status.ok, true);
  }
  // model_specialization "reasoning" + tier "local_strong" → gemma matches
  // (qwen is coding-only). gemma > nothing else local_strong+reasoning.
  assert.equal(result.model_recommendation.id, "gemma4:e4b-it-q4_K_M");
});

test("resource check can fail before fetch is called", async () => {
  let called = false;
  const runner = createOllamaClassifierRunner({
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

test("classifyWithOllama rejects resource failures instead of returning fallbacks", async () => {
  let called = false;

  await assert.rejects(
    classifyWithOllama(
      { messages: [{ role: "user", text: "review this" }] },
      {
        catalog: TEST_CATALOG,
        minTotalMemoryBytes: Number.MAX_SAFE_INTEGER,
        minAvailableMemoryBytes: Number.MAX_SAFE_INTEGER,
        fetch: async () => {
          called = true;
          return jsonResponse({
            message: { content: JSON.stringify(validOutputs.preflight) },
          });
        },
      },
    ),
    OllamaResourceError,
  );

  assert.equal(called, false);
});

function runnerReturning(payload) {
  return createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({ message: { content: JSON.stringify(payload) } }),
  });
}
