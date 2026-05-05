import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeOpenClassifyInput,
  sanitizeText,
  toClassifierInput,
} from "../dist/src/input.js";
import { userMessage } from "./fixtures.mjs";

test("sanitizes text in the documented order", () => {
  assert.equal(sanitizeText("\uFEFFcafe\u0301\x00\n\t\rb\x7F"), "café\n\t\rb");
});

test("rejects empty text after sanitization", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("\uFEFF\x00 \n\t\r")] }),
    /empty after sanitization/,
  );
});

test("rejects unknown top-level fields", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], provider_payload: {} }),
    /provider_payload is not a supported field/,
  );
});

test("does not preserve original raw text", () => {
  const normalized = normalizeOpenClassifyInput({ conversation_window: [message("\uFEFF hello\x00 ")] });

  assert.equal(normalized.text, "hello");
  assert.equal("raw_text" in normalized, false);
  assert.equal("original_text" in normalized, false);
});

test("message_hash is scoped to source conversation and thread", () => {
  const base = normalizeOpenClassifyInput({
    conversation_window: [message("same words")],
    source: "slack",
    conversation_id: "C1",
    thread_id: "T1",
  });
  const differentConversation = normalizeOpenClassifyInput({
    conversation_window: [message("same words")],
    source: "slack",
    conversation_id: "C2",
    thread_id: "T1",
  });
  const differentThread = normalizeOpenClassifyInput({
    conversation_window: [message("same words")],
    source: "slack",
    conversation_id: "C1",
    thread_id: "T2",
  });

  assert.notEqual(base.message_hash, differentConversation.message_hash);
  assert.notEqual(base.message_hash, differentThread.message_hash);
});

test("request_hash includes event and attachment metadata", () => {
  const base = normalizeOpenClassifyInput({
    conversation_window: [message("review this", {
      message_id: "message-a",
      timestamp: "2026-05-04T12:00:00Z",
    })],
    source: "email",
    conversation_id: "thread-a",
    attachments: [{ filename: "a.pdf", mime_type: "application/pdf" }],
  });
  const differentMessage = normalizeOpenClassifyInput({
    conversation_window: [message("review this", {
      message_id: "message-b",
      timestamp: "2026-05-04T12:00:00Z",
    })],
    source: "email",
    conversation_id: "thread-a",
    attachments: [{ filename: "a.pdf", mime_type: "application/pdf" }],
  });
  const differentAttachment = normalizeOpenClassifyInput({
    conversation_window: [message("review this", {
      message_id: "message-a",
      timestamp: "2026-05-04T12:00:00Z",
    })],
    source: "email",
    conversation_id: "thread-a",
    attachments: [{ filename: "b.pdf", mime_type: "application/pdf" }],
  });

  assert.notEqual(base.request_hash, differentMessage.request_hash);
  assert.notEqual(base.request_hash, differentAttachment.request_hash);
});

test("raw and external_request_id do not affect hashes", () => {
  const base = normalizeOpenClassifyInput({
    conversation_window: [message("same event", { message_id: "m" })],
    source: "api",
    conversation_id: "c",
    thread_id: "t",
    raw: { delivery: "one" },
    attachments: [{ filename: "a.txt", raw: { provider: "one" } }],
  });
  const withDifferentOpaqueMetadata = normalizeOpenClassifyInput({
    conversation_window: [message("same event", { message_id: "m" })],
    source: "api",
    conversation_id: "c",
    thread_id: "t",
    external_request_id: "different",
    raw: { delivery: "two" },
    attachments: [{ filename: "a.txt", raw: { provider: "two" } }],
  });

  assert.equal(base.message_hash, withDifferentOpaqueMetadata.message_hash);
  assert.equal(base.request_hash, withDifferentOpaqueMetadata.request_hash);
});

test("enforces payload caps", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("a".repeat(5_001))] }),
    /5000 characters/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], attachments: Array(21).fill({}) }),
    /20 items or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], source: "s".repeat(513) }),
    /512 characters or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({
      conversation_window: [message("hello")],
      attachments: [{ filename: "s".repeat(513) }],
    }),
    /512 characters or fewer/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], raw: { value: "x".repeat(65_536) } }),
    /65536 bytes or fewer/,
  );
});

test("validates raw as plain JSON-compatible objects", () => {
  const circular = {};
  circular.self = circular;

  assert.throws(() => normalizeOpenClassifyInput({ conversation_window: [message("hello")], raw: [] }), /plain object/);
  assert.throws(() => normalizeOpenClassifyInput({ conversation_window: [message("hello")], raw: new Date() }), /plain object/);
  assert.throws(() => normalizeOpenClassifyInput({ conversation_window: [message("hello")], raw: circular }), /circular/);
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], raw: { missing: undefined } }),
    /JSON values/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [message("hello")], attachments: [{ raw: new Map() }] }),
    /plain object/,
  );
});

test("accepts arbitrary attachment metadata without file contents", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: [message("inspect these")],
    attachments: [
      {
        filename: "photo.webp",
        size_bytes: 252_696,
        mime_type: "image/webp",
      },
      {
        filename: "archive.custom",
        size_bytes: 42,
        mime_type: "application/x-custom",
      },
    ],
  });

  assert.deepEqual(normalized.attachments, [
    {
      filename: "photo.webp",
      size_bytes: 252_696,
      mime_type: "image/webp",
    },
    {
      filename: "archive.custom",
      size_bytes: 42,
      mime_type: "application/x-custom",
    },
  ]);
});

test("toClassifierInput strips raw and exposes sanitized text", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: [message("\uFEFF hello\x00 ", {
      message_id: "M1",
      timestamp: "2026-05-04T12:00:00Z",
    })],
    external_request_id: "delivery-1",
    source: "slack",
    conversation_id: "C1",
    thread_id: "T1",
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
  assert.deepEqual(classifierInput.conversation_window, [
    {
      role: "user",
      text: "hello",
      message_id: "M1",
      timestamp: "2026-05-04T12:00:00Z",
    },
  ]);
  assert.equal("raw" in classifierInput, false);
  assert.equal("raw" in classifierInput.attachments[0], false);
  assert.equal(classifierInput.external_request_id, "delivery-1");
  assert.equal(classifierInput.attachments[0].filename, "contract.pdf");
});

test("normalizes conversation windows as whole-message context", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: [
      message("old"),
      message("meeting with Dave on Tuesday"),
      message("remind me at 3 PM"),
    ],
  });

  assert.equal(normalized.text, "remind me at 3 PM");
  assert.deepEqual(
    normalized.conversation_window.map((item) => item.text),
    ["old", "meeting with Dave on Tuesday", "remind me at 3 PM"],
  );
});

test("drops older whole messages to fit the sanitized text budget", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: [
      message("old"),
      message("a".repeat(3_000)),
      message("b".repeat(3_000)),
      message("final"),
    ],
  });

  assert.deepEqual(
    normalized.conversation_window.map((item) => item.text),
    ["b".repeat(3_000), "final"],
  );
});

test("skips empty context messages before applying the retained message count", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: [
      message("kept"),
      ...Array.from({ length: 25 }, () => message("\x00 ")),
      message("final"),
    ],
  });

  assert.deepEqual(
    normalized.conversation_window.map((item) => item.text),
    ["kept", "final"],
  );
});

test("requires the final message to be a user message when role is supplied", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [
          message("what should I do?"),
          { role: "assistant", text: "Here is a suggestion." },
        ],
      }),
    /must have role user/,
  );
});

test("keeps the newest 20 conversation messages", () => {
  const normalized = normalizeOpenClassifyInput({
    conversation_window: Array.from({ length: 25 }, (_, index) => message(`message ${index + 1}`)),
  });

  assert.equal(normalized.conversation_window.length, 20);
  assert.equal(normalized.conversation_window[0].text, "message 6");
  assert.equal(normalized.text, "message 25");
});

test("strips a single leading BOM and preserves later BOMs", () => {
  assert.equal(sanitizeText("﻿hello﻿world"), "hello﻿world");
});

test("normalizes Unicode to NFC", () => {
  assert.equal(sanitizeText("café"), "café");
  assert.equal(sanitizeText("café"), "café");
});

test("preserves tab, newline, and carriage return inside text", () => {
  assert.equal(sanitizeText("a\tb\nc\rd"), "a\tb\nc\rd");
});

test("rejects an empty conversation_window", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ conversation_window: [] }),
    /at least one message/,
  );
});

test("rejects context messages with role other than user or assistant", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [
          { role: "system", text: "you are helpful" },
          message("now what?"),
        ],
      }),
    /role must be user or assistant/,
  );
});

test("rejects oversize message_id and timestamp metadata", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [message("hi", { message_id: "m".repeat(513) })],
      }),
    /512 characters or fewer/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [message("hi", { timestamp: "t".repeat(513) })],
      }),
    /512 characters or fewer/,
  );
});

test("rejects unknown fields on conversation messages and attachments", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [{ role: "user", text: "hi", reactions: 1 }],
      }),
    /reactions is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [message("hi")],
        attachments: [{ filename: "a.txt", checksum: "abc" }],
      }),
    /checksum is not a supported field/,
  );
});

test("rejects attachments with negative or non-integer size_bytes", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [message("hi")],
        attachments: [{ filename: "a.txt", size_bytes: -1 }],
      }),
    /non-negative safe integer/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        conversation_window: [message("hi")],
        attachments: [{ filename: "a.txt", size_bytes: 1.5 }],
      }),
    /non-negative safe integer/,
  );
});

function message(text, extra = {}) {
  return userMessage(text, extra);
}
