import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeOpenClassifyInput,
  sanitizeText,
  toClassifierInput,
} from "../dist/src/input.js";

test("sanitizes text in the documented order", () => {
  assert.equal(sanitizeText("\uFEFFcafe\u0301\x00\n\t\rb\x7F"), "café\n\t\rb");
});

test("rejects empty text after sanitization", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "\uFEFF\x00 \n\t\r" }),
    /empty after sanitization/,
  );
});

test("rejects unknown top-level fields", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", provider_payload: {} }),
    /provider_payload is not a supported field/,
  );
});

test("does not preserve original raw text", () => {
  const normalized = normalizeOpenClassifyInput({ text: "\uFEFF hello\x00 " });

  assert.equal(normalized.text, "hello");
  assert.equal("raw_text" in normalized, false);
  assert.equal("original_text" in normalized, false);
});

test("message_hash is scoped to source conversation and thread", () => {
  const base = normalizeOpenClassifyInput({
    text: "same words",
    source: "slack",
    conversation_id: "C1",
    thread_id: "T1",
  });
  const differentConversation = normalizeOpenClassifyInput({
    text: "same words",
    source: "slack",
    conversation_id: "C2",
    thread_id: "T1",
  });
  const differentThread = normalizeOpenClassifyInput({
    text: "same words",
    source: "slack",
    conversation_id: "C1",
    thread_id: "T2",
  });

  assert.notEqual(base.message_hash, differentConversation.message_hash);
  assert.notEqual(base.message_hash, differentThread.message_hash);
});

test("request_hash includes event and attachment metadata", () => {
  const base = normalizeOpenClassifyInput({
    text: "review this",
    source: "email",
    conversation_id: "thread-a",
    message_id: "message-a",
    timestamp: "2026-05-04T12:00:00Z",
    attachments: [{ filename: "a.pdf", mime_type: "application/pdf" }],
  });
  const differentMessage = normalizeOpenClassifyInput({
    text: "review this",
    source: "email",
    conversation_id: "thread-a",
    message_id: "message-b",
    timestamp: "2026-05-04T12:00:00Z",
    attachments: [{ filename: "a.pdf", mime_type: "application/pdf" }],
  });
  const differentAttachment = normalizeOpenClassifyInput({
    text: "review this",
    source: "email",
    conversation_id: "thread-a",
    message_id: "message-a",
    timestamp: "2026-05-04T12:00:00Z",
    attachments: [{ filename: "b.pdf", mime_type: "application/pdf" }],
  });

  assert.notEqual(base.request_hash, differentMessage.request_hash);
  assert.notEqual(base.request_hash, differentAttachment.request_hash);
});

test("raw and external_request_id do not affect hashes", () => {
  const base = normalizeOpenClassifyInput({
    text: "same event",
    source: "api",
    conversation_id: "c",
    thread_id: "t",
    message_id: "m",
    raw: { delivery: "one" },
    attachments: [{ filename: "a.txt", raw: { provider: "one" } }],
  });
  const withDifferentOpaqueMetadata = normalizeOpenClassifyInput({
    text: "same event",
    source: "api",
    conversation_id: "c",
    thread_id: "t",
    message_id: "m",
    external_request_id: "different",
    raw: { delivery: "two" },
    attachments: [{ filename: "a.txt", raw: { provider: "two" } }],
  });

  assert.equal(base.message_hash, withDifferentOpaqueMetadata.message_hash);
  assert.equal(base.request_hash, withDifferentOpaqueMetadata.request_hash);
});

test("enforces payload caps", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "a".repeat(32_001) }),
    /32000 characters or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", attachments: Array(21).fill({}) }),
    /20 items or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", source: "s".repeat(513) }),
    /512 characters or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({
      text: "hello",
      attachments: [{ filename: "s".repeat(513) }],
    }),
    /512 characters or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", raw: { value: "x".repeat(65_536) } }),
    /65536 bytes or fewer/,
  );
});

test("validates raw as plain JSON-compatible objects", () => {
  const circular = {};
  circular.self = circular;

  assert.throws(() => normalizeOpenClassifyInput({ text: "hello", raw: [] }), /plain object/);
  assert.throws(() => normalizeOpenClassifyInput({ text: "hello", raw: new Date() }), /plain object/);
  assert.throws(() => normalizeOpenClassifyInput({ text: "hello", raw: circular }), /circular/);
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", raw: { missing: undefined } }),
    /JSON values/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ text: "hello", attachments: [{ raw: new Map() }] }),
    /plain object/,
  );
});

test("toClassifierInput strips raw and exposes sanitized text", () => {
  const normalized = normalizeOpenClassifyInput({
    text: "\uFEFF hello\x00 ",
    external_request_id: "delivery-1",
    source: "slack",
    conversation_id: "C1",
    thread_id: "T1",
    message_id: "M1",
    timestamp: "2026-05-04T12:00:00Z",
    raw: { provider: "metadata" },
    attachments: [
      {
        filename: "contract.pdf",
        size_bytes: 100,
        mime_type: "application/pdf",
        raw: { file_id: "F1" },
      },
    ],
  });

  const classifierInput = toClassifierInput(normalized);

  assert.equal(classifierInput.text, "hello");
  assert.equal("raw" in classifierInput, false);
  assert.equal("raw" in classifierInput.attachments[0], false);
  assert.equal(classifierInput.external_request_id, "delivery-1");
  assert.equal(classifierInput.attachments[0].filename, "contract.pdf");
});
