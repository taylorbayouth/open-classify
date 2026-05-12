// Input normalization. This module enforces the Open Classify input contract
// before anything model-shaped happens: structural shape, allowed fields,
// sanitized text, payload budget, and a stable target-message hash. Anything
// that throws here surfaces as `OpenClassifyNormalizationError` to callers.

import { createHash } from "node:crypto";
import type {
  ClassifierInput,
  ConversationMessageInput,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

/*
 * Message text budget:
 *
 * Gemma 4 E4B supports a native 131,072-token (128K) context window. Open
 * Classify does not use that full window in the reference local runtime: it
 * runs the classifier set in parallel with a configured 4,096-token context.
 * The largest fixed classifier prompt is security at about 1,748 estimated
 * tokens using the same 3 chars/token heuristic as the Ollama packer. We round
 * that up to 2,000 fixed-prompt tokens, reserve roughly 400 tokens for output,
 * chat-template variance, and estimation error, then spend the remainder on
 * sanitized conversation text:
 *
 *   4,096 - 2,000 - 400 = 1,696 text tokens
 *   1,696 * 3 chars/token = 5,088 chars
 *
 * Use a round 5,000-character API budget. The Ollama runner still validates the
 * fully rendered prompt for the configured num_ctx and drops older whole
 * context messages when a caller overrides num_ctx lower.
 */
const CONVERSATION_TEXT_MAX_CHARS = 5_000;
const MESSAGE_HISTORY_MAX_COUNT = 20;

const INPUT_FIELDS = new Set([
  "messages",
]);

const CONVERSATION_MESSAGE_FIELDS = new Set([
  "role",
  "text",
]);

type JsonRecord = Record<string, unknown>;

// Strip the BOM, normalize composed/decomposed Unicode (so "café" never has
// two encodings), drop control chars except tab/newline/CR, and trim. Tabs
// and newlines are kept because they're load-bearing in code/markdown
// snippets that users paste in.
export function sanitizeText(raw: string): string {
  let text = raw;

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return text
    .normalize("NFC")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

// 8-hex-char fingerprint of the canonicalized value. Short on purpose —
// this is for correlation/dedup, not cryptographic identity. Canonicalization
// (sorted keys, undefined-stripped) makes the hash stable across input order.
function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 8);
}

export function normalizeOpenClassifyInput(
  input: OpenClassifyInput,
): NormalizedOpenClassifyInput {
  assertPlainObject(input, "input");
  rejectUnknownFields(input, INPUT_FIELDS, "input");

  const messages = normalizeMessages(input.messages);
  const target = messages[messages.length - 1];
  const text = target.text;

  const normalized: NormalizedOpenClassifyInput = {
    messages,
    text,
    target_message_hash: "",
  };

  normalized.target_message_hash = hashCanonicalValue({
    role: target.role ?? "user",
    text,
  });

  return normalized;
}

export function toClassifierInput(
  normalized: NormalizedOpenClassifyInput,
): ClassifierInput {
  return {
    text: normalized.text,
    messages: normalized.messages,
    target_message_hash: normalized.target_message_hash,
  };
}

function normalizeMessages(
  messages: ConversationMessageInput[] | undefined,
): ConversationMessageInput[] {
  if (!Array.isArray(messages)) {
    throw new TypeError("input.messages must be an array");
  }
  if (messages.length === 0) {
    throw new Error("input.messages must contain at least one message");
  }

  return takeNewestWholeMessagesThatFit(messages);
}

function normalizeConversationMessage(
  message: ConversationMessageInput,
  path: string,
): ConversationMessageInput {
  assertPlainObject(message, path);
  rejectUnknownFields(message, CONVERSATION_MESSAGE_FIELDS, path);

  if (typeof message.text !== "string") {
    throw new TypeError(`${path}.text must be a string`);
  }

  const normalized: ConversationMessageInput = {
    text: sanitizeText(message.text),
  };

  if (message.role !== undefined) {
    if (!["user", "assistant"].includes(message.role)) {
      throw new TypeError(`${path}.role must be user or assistant`);
    }
    normalized.role = message.role;
  }

  return normalized;
}

// Walk the message history newest → oldest, keeping whole messages while
// we're under both the count cap and the character budget. The final
// message is non-negotiable (it's what we're classifying) — we validate it
// stricter, force role=user, and never drop it on length grounds.
//
// We never slice text inside a message: classifiers depend on the full
// final message, and slicing earlier ones at arbitrary boundaries tends to
// confuse models more than it helps.
function takeNewestWholeMessagesThatFit(
  messages: ConversationMessageInput[],
): ConversationMessageInput[] {
  const selected: ConversationMessageInput[] = [];
  let totalChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeConversationMessage(
      messages[index],
      `input.messages[${index}]`,
    );
    const isFinalMessage = index === messages.length - 1;

    if (isFinalMessage) {
      if (normalized.text.length === 0) {
        throw new Error("final message is empty after sanitization");
      }
      if (normalized.role !== undefined && normalized.role !== "user") {
        throw new Error("final message must have role user");
      }
      normalized.role = "user";
      if (normalized.text.length > CONVERSATION_TEXT_MAX_CHARS) {
        throw new RangeError(
          `final message must be ${CONVERSATION_TEXT_MAX_CHARS} characters or fewer`,
        );
      }
    } else if (normalized.text.length === 0) {
      continue;
    }

    if (!isFinalMessage && selected.length >= MESSAGE_HISTORY_MAX_COUNT) {
      break;
    }
    if (!isFinalMessage && totalChars + normalized.text.length > CONVERSATION_TEXT_MAX_CHARS) {
      break;
    }

    selected.push(normalized);
    totalChars += normalized.text.length;
  }

  return selected.reverse();
}

// Reject class instances and prototype-tampered objects, not just non-objects.
// We want plain `{}` shapes here — anything carrying behavior or an exotic
// prototype could surprise the JSON serializer or smuggle properties past
// `rejectUnknownFields`.
function assertPlainObject(value: unknown, path: string): asserts value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
}

function rejectUnknownFields(
  value: JsonRecord,
  allowedFields: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new TypeError(`${path}.${key} is not a supported field`);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// Recursive deep-sort of object keys + drop of `undefined` values. Used by
// `hashCanonicalValue` so the hash is invariant under input key ordering —
// `{a:1,b:2}` and `{b:2,a:1}` produce the same fingerprint.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      result[key] = canonicalize(child);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
