import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLASSIFIERS } from "../dist/src/classifiers.js";
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
  assert.equal(OLLAMA_CLASSIFIER_ADAPTER_MODELS.preflight, "open-classify-preflight:v0.1.0");
  assert.equal(
    OLLAMA_CLASSIFIER_ADAPTER_MODELS.context_sufficiency,
    "open-classify-context-sufficiency:v0.1.0",
  );
});

test("discovers classifier adapters from JSON config incrementally", async () => {
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

test("createOllamaClassifierRunner falls back to base model for missing adapter config entries", async () => {
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
  assert.match(body.messages[0].content, /preflight classifier/);
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /The target user message is the final message in the window\./);
  assert.match(body.messages[1].content, /Message 1 \(target\):/);
  assert.match(body.messages[1].content, /text:\nhello/);
  assert.match(body.messages[1].content, /filename: Welcome\.md/);
  assert.match(body.messages[1].content, /mime_type: text\/markdown/);
  assert.match(body.messages[1].content, /size_bytes: 203/);
  assert.doesNotMatch(body.messages[1].content, /message_hash|request_hash/);
});

test("createOllamaClassifierRunner drops older whole messages to fit estimated context", async () => {
  const calls = [];
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    options: { num_ctx: 1000 },
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
      conversation_window: [
        { role: "user", text: `older context ${"x".repeat(1200)}` },
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
        conversation_window: [{ role: "user", text: "x".repeat(10_000) }],
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

test("createOllamaClassifierRunner validates preflight terminality enum", async () => {
  const runner = runnerReturning({ terminality: "bad", awk: "Nope." });

  await assert.rejects(
    runner("preflight", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates routing enum values", async () => {
  const runner = runnerReturning({
    execution_mode: "tool_assisted",
    model_tier: "ultra_strong",
  });

  await assert.rejects(
    runner("routing", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "routing" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates context_sufficiency missing_context cap", async () => {
  const runner = runnerReturning({
    value: "referential",
    missing_context: ["a", "b", "c", "d", "e", "f"],
    relevant_context_summary: "",
  });

  await assert.rejects(
    runner("context_sufficiency", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "context_sufficiency" &&
      /missing_context/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates memory query word count", async () => {
  const runner = runnerReturning({ queries: ["too short"] });

  await assert.rejects(
    runner("memory_retrieval_queries", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "memory_retrieval_queries" &&
      /queries\[0\] must be 3 to 10 words/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects duplicate tool families", async () => {
  const runner = runnerReturning({ needed: true, families: ["workspace", "workspace"] });

  await assert.rejects(
    runner("tools", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "tools" &&
      /families must not include duplicates/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates digest slug format", async () => {
  const runner = runnerReturning({
    slug: "Review Request",
    summary: "The user wants a review.",
    attachments: [],
  });

  await assert.rejects(
    runner("message_and_attachment_digest", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "message_and_attachment_digest" &&
      /slug must be snake_case/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates security risk-level / signals consistency", async () => {
  const runner = runnerReturning({
    risk_level: "normal",
    signals: ["instruction_attack"],
    notes: "Conflicting output.",
  });

  await assert.rejects(
    runner("security", classifierInput(), new AbortController().signal),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "security" &&
      /normal risk_level must not include signals/.test(error.message),
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
    { conversation_window: [{ role: "user", text: "review this" }], raw: { keep: true } },
    {
      skipResourceCheck: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.model, OLLAMA_BASE_MODEL);
        const systemPrompt = body.messages[0].content;
        const name = Object.keys(CLASSIFIERS).find(
          (classifierName) => CLASSIFIERS[classifierName].systemPrompt === systemPrompt,
        );
        assert.ok(name);

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
  assert.equal(result.request.raw.keep, true);
  assert.deepEqual(result.classifiers, validOutputs);
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

function runnerReturning(payload) {
  return createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({ message: { content: JSON.stringify(payload) } }),
  });
}
