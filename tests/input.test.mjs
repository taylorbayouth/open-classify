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
    () => normalizeOpenClassifyInput({ messages: [message("\uFEFF\x00 \n\t\r")] }),
    /empty after sanitization/,
  );
});

test("rejects unknown top-level fields", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [message("hello")], provider_payload: {} }),
    /provider_payload is not a supported field/,
  );
});

test("does not preserve original raw text", () => {
  const normalized = normalizeOpenClassifyInput({ messages: [message("\uFEFF hello\x00 ")] });

  assert.equal(normalized.text, "hello");
  assert.equal("raw_text" in normalized, false);
  assert.equal("original_text" in normalized, false);
});

test("target_message_hash is generated from the sanitized target message", () => {
  const base = normalizeOpenClassifyInput({
    messages: [message("older context"), message("\uFEFF same words\x00 ")],
  });
  const differentContext = normalizeOpenClassifyInput({
    messages: [message("different context"), message("same words")],
  });
  const differentTarget = normalizeOpenClassifyInput({
    messages: [message("older context"), message("different words")],
  });

  assert.equal(base.target_message_hash, differentContext.target_message_hash);
  assert.notEqual(base.target_message_hash, differentTarget.target_message_hash);
});

test("old caller metadata fields are rejected instead of passed through", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [message("hello")], external_request_id: "delivery-1" }),
    /external_request_id is not a supported field/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [message("hello")], source: "api" }),
    /source is not a supported field/,
  );
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [message("hello")], raw: { keep: true } }),
    /raw is not a supported field/,
  );
});

test("enforces payload caps", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [message("a".repeat(5_001))] }),
    /5000 characters/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hello")],
        attachments: [{ filename: "s".repeat(513) }],
      }),
    /512 characters or fewer/,
  );
});

test("accepts any number of attachments", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [message("inspect these")],
    attachments: Array.from({ length: 50 }, (_, index) => ({
      filename: `file-${index + 1}.custom`,
      mime_type: `application/x-custom-${index + 1}`,
      size_bytes: index,
    })),
  });

  assert.equal(normalized.attachments.length, 50);
  assert.equal(normalized.attachments[49].filename, "file-50.custom");
});

test("accepts arbitrary attachment metadata without file contents", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [message("inspect these")],
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

test("toClassifierInput exposes only sanitized messages, attachment metadata, and target hash", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [message("\uFEFF hello\x00 ")],
    attachments: [
      {
        filename: "contract.pdf",
        size_bytes: 100,
        mime_type: "application/pdf",
      },
    ],
  });

  const classifierInput = toClassifierInput(normalized);

  assert.equal(classifierInput.text, "hello");
  assert.deepEqual(classifierInput.messages, [
    {
      role: "user",
      text: "hello",
    },
  ]);
  assert.equal(classifierInput.target_message_hash, normalized.target_message_hash);
  assert.equal(classifierInput.attachments[0].filename, "contract.pdf");
});

test("normalizes messages as whole-message context", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [
      message("old"),
      message("meeting with Dave on Tuesday"),
      message("remind me at 3 PM"),
    ],
  });

  assert.equal(normalized.text, "remind me at 3 PM");
  assert.deepEqual(
    normalized.messages.map((item) => item.text),
    ["old", "meeting with Dave on Tuesday", "remind me at 3 PM"],
  );
});

test("drops older whole messages to fit the sanitized text budget", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [
      message("old"),
      message("a".repeat(3_000)),
      message("b".repeat(3_000)),
      message("final"),
    ],
  });

  assert.deepEqual(
    normalized.messages.map((item) => item.text),
    ["b".repeat(3_000), "final"],
  );
});

test("skips empty context messages before applying the retained message count", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: [
      message("kept"),
      ...Array.from({ length: 25 }, () => message("\x00 ")),
      message("final"),
    ],
  });

  assert.deepEqual(
    normalized.messages.map((item) => item.text),
    ["kept", "final"],
  );
});

test("requires the final message to be a user message when role is supplied", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [
          message("what should I do?"),
          { role: "assistant", text: "Here is a suggestion." },
        ],
      }),
    /must have role user/,
  );
});

test("keeps the newest 20 messages", () => {
  const normalized = normalizeOpenClassifyInput({
    messages: Array.from({ length: 25 }, (_, index) => message(`message ${index + 1}`)),
  });

  assert.equal(normalized.messages.length, 20);
  assert.equal(normalized.messages[0].text, "message 6");
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

test("rejects an empty messages array", () => {
  assert.throws(
    () => normalizeOpenClassifyInput({ messages: [] }),
    /at least one message/,
  );
});

test("rejects context messages with role other than user or assistant", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [
          { role: "system", text: "you are helpful" },
          message("now what?"),
        ],
      }),
    /role must be user or assistant/,
  );
});

test("rejects old message metadata fields", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi", { message_id: "m1" })],
      }),
    /message_id is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi", { timestamp: "2026-05-04T12:00:00Z" })],
      }),
    /timestamp is not a supported field/,
  );
});

test("rejects unknown fields on messages and attachments", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [{ role: "user", text: "hi", reactions: 1 }],
      }),
    /reactions is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi")],
        attachments: [{ filename: "a.txt", checksum: "abc" }],
      }),
    /checksum is not a supported field/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi")],
        attachments: [{ filename: "a.txt", raw: { file_id: "F1" } }],
      }),
    /raw is not a supported field/,
  );
});

test("rejects attachments with negative or non-integer size_bytes", () => {
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi")],
        attachments: [{ filename: "a.txt", size_bytes: -1 }],
      }),
    /non-negative safe integer/,
  );
  assert.throws(
    () =>
      normalizeOpenClassifyInput({
        messages: [message("hi")],
        attachments: [{ filename: "a.txt", size_bytes: 1.5 }],
      }),
    /non-negative safe integer/,
  );
});

function message(text, extra = {}) {
  return userMessage(text, extra);
}
