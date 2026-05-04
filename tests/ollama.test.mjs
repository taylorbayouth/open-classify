import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASSIFIERS } from "../dist/src/classifiers.js";
import {
  classifyWithOllama,
  createOllamaClassifierRunner,
  OllamaClassifierError,
  OllamaResourceError,
  OLLAMA_CLASSIFIER_ADAPTER_MODELS,
  OLLAMA_BASE_MODEL,
  OLLAMA_CLASSIFIER_MODELS,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_REQUIRED_PARALLELISM,
} from "../dist/src/ollama.js";

const validOutputs = {
  preflight: { terminality: "continue", awk: "I'll take a look." },
  downstream_route: { value: "tool_harness_answer" },
  additional_history_need: { value: "current_message_only" },
  memory_retrieval_queries: { queries: ["review request"] },
  tool_family_need: { value: ["workspace"] },
  message_and_attachment_digest: {
    slug: "review_request",
    summary: "The user wants a review.",
    attachments: [],
  },
  security_posture: { value: "normal", signals: [], notes: "No notable risk." },
};

test("exports Ollama default runtime identity", () => {
  assert.equal(OLLAMA_DEFAULT_HOST, "http://localhost:11434");
  assert.equal(OLLAMA_BASE_MODEL, "gemma4:e4b-it-q4_K_M");
  assert.equal(OLLAMA_REQUIRED_PARALLELISM, 7);
  assert.equal(OLLAMA_CLASSIFIER_MODELS.preflight, null);
  assert.equal(OLLAMA_CLASSIFIER_ADAPTER_MODELS.preflight, "open-classify-preflight:v0.1.0");
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
    {
      text: "hello",
      attachments: [],
      message_hash: "message",
      request_hash: "request",
    },
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
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /preflight classifier/);
  assert.equal(body.messages[1].role, "user");
  assert.match(body.messages[1].content, /"text":"hello"/);
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

  await runner(
    "preflight",
    {
      text: "hello",
      attachments: [],
      message_hash: "message",
      request_hash: "request",
    },
    new AbortController().signal,
  );

  assert.equal(calls[0].model, OLLAMA_BASE_MODEL);
});

test("createOllamaClassifierRunner validates classifier output", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: { content: JSON.stringify({ terminality: "bad", awk: "Nope." }) },
      }),
  });

  await assert.rejects(
    runner(
      "preflight",
      {
        text: "hello",
        attachments: [],
        message_hash: "message",
        request_hash: "request",
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "preflight" &&
      /unsupported value/.test(error.message),
  );
});

test("createOllamaClassifierRunner surfaces Ollama errors", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () => jsonResponse({ error: "model not found" }, { ok: false, statusText: "Not Found" }),
  });

  await assert.rejects(
    runner(
      "security_posture",
      {
        text: "hello",
        attachments: [],
        message_hash: "message",
        request_hash: "request",
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "security_posture" &&
      /model not found/.test(error.message),
  );
});

test("classifyWithOllama uses the Ollama runner in the pipeline", async () => {
  const result = await classifyWithOllama(
    { text: "review this", raw: { keep: true } },
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

        assert.match(body.messages[1].content, /"text":"review this"/);
        assert.doesNotMatch(body.messages[1].content, /"raw"/);

        return jsonResponse({
          message: { content: JSON.stringify(validOutputs[name]) },
        });
      },
    },
  );

  assert.equal(result.status, "continue");
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
    runner(
      "preflight",
      {
        text: "hello",
        attachments: [],
        message_hash: "message",
        request_hash: "request",
      },
      new AbortController().signal,
    ),
    OllamaResourceError,
  );
  assert.equal(called, false);
});

function jsonResponse(payload, overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    statusText: overrides.statusText ?? "OK",
    async json() {
      return payload;
    },
  };
}
