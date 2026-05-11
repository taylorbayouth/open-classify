// Behavioral eval for the conversation_history classifier prompt.
//
// tests/ollama.test.mjs mocks model output to verify runner/schema logic.
// This file calls the real local model with hand-built conversations and
// asserts that `prior_messages_needed` is wide enough to preserve named
// entities introduced earlier in the thread. The intent is to guard against
// the silent under-inclusion failure where the model confidently returns a
// small count and drops the entity that the downstream model needs.
//
// Skips gracefully when Ollama is unreachable or the resolved model is
// not installed, so it is safe to leave in the default `npm test` flow.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOllamaClassifierRunner,
  discoverOllamaClassifierAdapterModels,
  OLLAMA_BASE_MODEL,
  OLLAMA_DEFAULT_HOST,
} from "../dist/src/ollama.js";

const HOST = process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_HOST;
const RESOLVED_MODEL =
  discoverOllamaClassifierAdapterModels().conversation_history ?? OLLAMA_BASE_MODEL;
const TEST_TIMEOUT_MS = 120_000;

async function isModelAvailable() {
  try {
    const response = await fetch(`${HOST}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    return models.some(
      (entry) => entry?.name === RESOLVED_MODEL || entry?.model === RESOLVED_MODEL,
    );
  } catch {
    return false;
  }
}

function makeInput(messages) {
  const last = messages[messages.length - 1];
  return {
    text: last.text,
    messages,
    attachments: [],
    target_message_hash: "eval-test-hash",
  };
}

const FIXTURES = [
  {
    name: "entity introduced 6 messages back is captured",
    messages: [
      { role: "user", text: "We're working on the Acme Corp renewal next week." },
      { role: "assistant", text: "Got it." },
      { role: "user", text: "For this client, use a concise, warm tone." },
      { role: "assistant", text: "Noted: concise and warm." },
      { role: "user", text: "Also, no exclamation points." },
      { role: "assistant", text: "Understood — no exclamation points." },
      { role: "user", text: "Draft the renewal update." },
    ],
    expect(result) {
      assert.equal(result.is_standalone, false, "expected non-standalone");
      assert.equal(result.refers_to_history, true, "expected refers_to_history");
      assert.ok(
        result.prior_messages_needed >= 6,
        `expected window >= 6 (Acme entity at msg -7); got ${result.prior_messages_needed}`,
      );
    },
  },
  {
    name: "genuinely standalone question gets zero prior messages",
    messages: [
      {
        role: "user",
        text: "What are the tradeoffs of SQLite and Postgres for an offline app?",
      },
    ],
    expect(result) {
      assert.equal(result.is_standalone, true, "expected standalone");
      assert.equal(result.refers_to_history, false, "expected refers_to_history false");
      assert.equal(
        result.prior_messages_needed,
        0,
        "standalone questions should not be padded",
      );
    },
  },
  {
    name: "make that shorter — short reference resolves with one prior",
    messages: [
      {
        role: "assistant",
        text: "Here's the announcement draft: today we're launching version 4.0 with new features X, Y, Z.",
      },
      { role: "user", text: "Make that shorter." },
    ],
    expect(result) {
      assert.equal(result.is_standalone, false);
      assert.equal(result.refers_to_history, true);
      assert.ok(
        result.prior_messages_needed >= 1,
        `expected window >= 1; got ${result.prior_messages_needed}`,
      );
    },
  },
  {
    name: "renewal-update regression: client identity preserved",
    // Mirrors the failure transcript that motivated this eval. Old prompt
    // returned prior_messages_needed: 2, which captured tone but lost the
    // client identity. New prompt should return more than 2.
    messages: [
      {
        role: "user",
        text: "We're starting work on the Acme Corp account renewal next week.",
      },
      { role: "assistant", text: "Sounds good." },
      { role: "user", text: "Their AE is Jordan." },
      { role: "assistant", text: "Understood — Jordan is the AE on Acme's renewal." },
      {
        role: "user",
        text: "For this client, use a concise, warm tone and avoid exclamation points. They dislike anything that sounds salesy.",
      },
      {
        role: "assistant",
        text: "Noted for this thread: concise and warm, no exclamation points, no salesy language.",
      },
      { role: "user", text: "Draft the renewal update." },
    ],
    expect(result) {
      assert.equal(result.is_standalone, false);
      assert.equal(result.refers_to_history, true);
      assert.ok(
        result.prior_messages_needed > 2,
        `regression: expected window > 2 (old prompt returned 2 here); got ${result.prior_messages_needed}`,
      );
    },
  },
  {
    name: "entity introduced 8 messages back is still captured",
    messages: [
      { role: "user", text: "I prefer Postgres for the new project." },
      { role: "assistant", text: "Got it." },
      { role: "user", text: "Let's also use TypeScript." },
      { role: "assistant", text: "Sure." },
      { role: "user", text: "Target deploy is Fly.io." },
      { role: "assistant", text: "Noted." },
      { role: "user", text: "Use Vite for the frontend." },
      { role: "assistant", text: "Vite confirmed." },
      { role: "user", text: "Set up the database." },
    ],
    expect(result) {
      assert.equal(result.is_standalone, false);
      assert.ok(
        result.prior_messages_needed >= 8,
        `expected window >= 8 (Postgres preference at msg -9); got ${result.prior_messages_needed}`,
      );
    },
  },
];

const reachable = await isModelAvailable();

if (!reachable) {
  test(
    `conversation_history eval: skipped (Ollama or model "${RESOLVED_MODEL}" unavailable at ${HOST})`,
    { skip: true },
    () => {},
  );
} else {
  const runner = createOllamaClassifierRunner({ skipResourceCheck: true });

  for (const fixture of FIXTURES) {
    test(
      `conversation_history eval: ${fixture.name}`,
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const input = makeInput(fixture.messages);
        const controller = new AbortController();
        const result = await runner(
          "conversation_history",
          input,
          controller.signal,
        );
        fixture.expect(result);
      },
    );
  }
}
