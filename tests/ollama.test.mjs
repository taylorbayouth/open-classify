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
  OLLAMA_CONTEXT_LENGTH,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_REQUIRED_PARALLELISM,
} from "../dist/src/ollama.js";

const validOutputs = {
  preflight: { terminality: "continue", awk: "I'll take a look." },
  downstream_route: { value: "tool_harness_answer" },
  context_sufficiency: {
    value: "self_contained",
    missing: [],
  },
  memory_retrieval_queries: { queries: ["user review preferences"] },
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
  assert.equal(OLLAMA_CONTEXT_LENGTH, 4096);
  assert.equal(OLLAMA_CLASSIFIER_MODELS.preflight, null);
  assert.equal(OLLAMA_CLASSIFIER_ADAPTER_MODELS.preflight, "open-classify-preflight:v0.1.0");
  assert.equal(
    OLLAMA_CLASSIFIER_ADAPTER_MODELS.context_sufficiency,
    "open-classify-context-sufficiency:v0.1.0",
  );
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
      conversation_window: [{ role: "user", text: "hello" }],
      attachments: [
        {
          filename: "Welcome.md",
          mime_type: "text/markdown",
          size_bytes: 203,
        },
      ],
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
    {
      text: "final request",
      conversation_window: [
        { role: "user", text: `older context ${"x".repeat(1200)}` },
        { role: "user", text: "final request" },
      ],
      attachments: [],
      message_hash: "message",
      request_hash: "request",
    },
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
      {
        text: "x".repeat(10_000),
        conversation_window: [{ role: "user", text: "x".repeat(10_000) }],
        attachments: [],
        message_hash: "message",
        request_hash: "request",
      },
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

  await runner(
    "preflight",
    {
      text: "hello",
      conversation_window: [{ role: "user", text: "hello" }],
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
        conversation_window: [{ role: "user", text: "hello" }],
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

test("createOllamaClassifierRunner validates memory query shape", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: { content: JSON.stringify({ queries: ["too short"] }) },
      }),
  });

  await assert.rejects(
    runner(
      "memory_retrieval_queries",
      classifierInput(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "memory_retrieval_queries" &&
      /queries\[0\] must be 3 to 10 words/.test(error.message),
  );
});

test("createOllamaClassifierRunner rejects duplicate tool families", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: { content: JSON.stringify({ value: ["workspace", "workspace"] }) },
      }),
  });

  await assert.rejects(
    runner(
      "tool_family_need",
      classifierInput(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "tool_family_need" &&
      /value must not include duplicates/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates digest contract", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: {
          content: JSON.stringify({
            slug: "Review Request",
            summary: "The user wants a review.",
            attachments: [],
          }),
        },
      }),
  });

  await assert.rejects(
    runner(
      "message_and_attachment_digest",
      classifierInput(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "message_and_attachment_digest" &&
      /slug must be snake_case/.test(error.message),
  );
});

test("createOllamaClassifierRunner validates security posture consistency", async () => {
  const runner = createOllamaClassifierRunner({
    skipResourceCheck: true,
    fetch: async () =>
      jsonResponse({
        message: {
          content: JSON.stringify({
            value: "normal",
            signals: ["system_prompt_probe"],
            notes: "Conflicting output.",
          }),
        },
      }),
  });

  await assert.rejects(
    runner(
      "security_posture",
      classifierInput(),
      new AbortController().signal,
    ),
    (error) =>
      error instanceof OllamaClassifierError &&
      error.classifier === "security_posture" &&
      /normal posture must not include signals/.test(error.message),
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
        conversation_window: [{ role: "user", text: "hello" }],
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
        conversation_window: [{ role: "user", text: "hello" }],
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

function classifierInput() {
  return {
    text: "hello",
    conversation_window: [{ role: "user", text: "hello" }],
    attachments: [],
    message_hash: "message",
    request_hash: "request",
  };
}
