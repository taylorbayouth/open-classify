import { createHash } from "node:crypto";
import type {
  AttachmentInput,
  ClassifierAttachmentInput,
  ClassifierInput,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
} from "./types.js";

const TEXT_MAX_CHARS = 32_000;
const ATTACHMENT_MAX_COUNT = 20;
const METADATA_STRING_MAX_CHARS = 512;
const RAW_MAX_BYTES = 64 * 1024;

const INPUT_FIELDS = new Set([
  "text",
  "external_request_id",
  "source",
  "conversation_id",
  "thread_id",
  "message_id",
  "timestamp",
  "raw",
  "attachments",
]);

const ATTACHMENT_FIELDS = new Set([
  "filename",
  "size_bytes",
  "mime_type",
  "raw",
]);

type JsonRecord = Record<string, unknown>;

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

function hashCanonicalValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizeOpenClassifyInput(
  input: OpenClassifyInput,
): NormalizedOpenClassifyInput {
  assertPlainObject(input, "input");
  rejectUnknownFields(input, INPUT_FIELDS, "input");

  if (typeof input.text !== "string") {
    throw new TypeError("input.text must be a string");
  }

  const text = sanitizeText(input.text);
  if (text.length === 0) {
    throw new Error("input.text is empty after sanitization");
  }
  if (text.length > TEXT_MAX_CHARS) {
    throw new RangeError(`input.text must be ${TEXT_MAX_CHARS} characters or fewer`);
  }

  const normalized: NormalizedOpenClassifyInput = {
    text,
    attachments: normalizeAttachments(input.attachments),
    message_hash: "",
    request_hash: "",
  };

  copyMetadataString(input, normalized, "external_request_id");
  copyMetadataString(input, normalized, "source");
  copyMetadataString(input, normalized, "conversation_id");
  copyMetadataString(input, normalized, "thread_id");
  copyMetadataString(input, normalized, "message_id");
  copyMetadataString(input, normalized, "timestamp");

  if (input.raw !== undefined) {
    normalized.raw = validateRaw(input.raw, "input.raw");
  }

  normalized.message_hash = hashCanonicalValue({
    source: normalized.source,
    conversation_id: normalized.conversation_id,
    thread_id: normalized.thread_id,
    text,
  });

  normalized.request_hash = hashCanonicalValue({
    source: normalized.source,
    conversation_id: normalized.conversation_id,
    thread_id: normalized.thread_id,
    message_id: normalized.message_id,
    timestamp: normalized.timestamp,
    text,
    attachments: normalized.attachments.map((attachment) => ({
      filename: attachment.filename,
      size_bytes: attachment.size_bytes,
      mime_type: attachment.mime_type,
    })),
  });

  return normalized;
}

export function toClassifierInput(
  normalized: NormalizedOpenClassifyInput,
): ClassifierInput {
  assertPlainObject(normalized, "normalized");

  const classifierInput: ClassifierInput = {
    text: normalized.text,
    attachments: normalizeClassifierAttachments(normalized.attachments),
    message_hash: normalized.message_hash,
    request_hash: normalized.request_hash,
  };

  copyClassifierString(normalized, classifierInput, "external_request_id");
  copyClassifierString(normalized, classifierInput, "source");
  copyClassifierString(normalized, classifierInput, "conversation_id");
  copyClassifierString(normalized, classifierInput, "thread_id");
  copyClassifierString(normalized, classifierInput, "message_id");
  copyClassifierString(normalized, classifierInput, "timestamp");

  return classifierInput;
}

function normalizeAttachments(attachments: AttachmentInput[] | undefined): AttachmentInput[] {
  if (attachments === undefined) {
    return [];
  }
  if (!Array.isArray(attachments)) {
    throw new TypeError("input.attachments must be an array");
  }
  if (attachments.length > ATTACHMENT_MAX_COUNT) {
    throw new RangeError(
      `input.attachments must contain ${ATTACHMENT_MAX_COUNT} items or fewer`,
    );
  }

  return attachments.map((attachment, index) => {
    const path = `input.attachments[${index}]`;
    assertPlainObject(attachment, path);
    rejectUnknownFields(attachment, ATTACHMENT_FIELDS, path);

    const normalized: AttachmentInput = {};
    copyAttachmentString(attachment, normalized, "filename", path, METADATA_STRING_MAX_CHARS);
    copyAttachmentString(attachment, normalized, "mime_type", path, METADATA_STRING_MAX_CHARS);

    if (attachment.size_bytes !== undefined) {
      if (
        typeof attachment.size_bytes !== "number" ||
        !Number.isSafeInteger(attachment.size_bytes) ||
        attachment.size_bytes < 0
      ) {
        throw new TypeError(`${path}.size_bytes must be a non-negative safe integer`);
      }
      normalized.size_bytes = attachment.size_bytes;
    }

    if (attachment.raw !== undefined) {
      normalized.raw = validateRaw(attachment.raw, `${path}.raw`);
    }

    return normalized;
  });
}

function normalizeClassifierAttachments(
  attachments: AttachmentInput[],
): ClassifierAttachmentInput[] {
  if (!Array.isArray(attachments)) {
    throw new TypeError("normalized.attachments must be an array");
  }

  return attachments.map((attachment, index) => {
    const path = `normalized.attachments[${index}]`;
    assertPlainObject(attachment, path);

    const classifierAttachment: ClassifierAttachmentInput = {};
    copyAttachmentString(
      attachment,
      classifierAttachment,
      "filename",
      path,
      METADATA_STRING_MAX_CHARS,
    );
    copyAttachmentString(
      attachment,
      classifierAttachment,
      "mime_type",
      path,
      METADATA_STRING_MAX_CHARS,
    );

    if (attachment.size_bytes !== undefined) {
      if (
        typeof attachment.size_bytes !== "number" ||
        !Number.isSafeInteger(attachment.size_bytes) ||
        attachment.size_bytes < 0
      ) {
        throw new TypeError(`${path}.size_bytes must be a non-negative safe integer`);
      }
      classifierAttachment.size_bytes = attachment.size_bytes;
    }

    return classifierAttachment;
  });
}

function copyMetadataString(
  source: OpenClassifyInput,
  target: OpenClassifyInput,
  key:
    | "external_request_id"
    | "source"
    | "conversation_id"
    | "thread_id"
    | "message_id"
    | "timestamp",
): void {
  const value = source[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError(`input.${key} must be a string`);
  }
  if (value.length > METADATA_STRING_MAX_CHARS) {
    throw new RangeError(
      `input.${key} must be ${METADATA_STRING_MAX_CHARS} characters or fewer`,
    );
  }
  target[key] = value;
}

function copyClassifierString(
  source: NormalizedOpenClassifyInput,
  target: ClassifierInput,
  key:
    | "external_request_id"
    | "source"
    | "conversation_id"
    | "thread_id"
    | "message_id"
    | "timestamp",
): void {
  const value = source[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

function copyAttachmentString(
  source: AttachmentInput,
  target: AttachmentInput,
  key: "filename" | "mime_type",
  path: string,
  maxChars: number,
): void {
  const value = source[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${path}.${key} must be a string`);
  }
  if (value.length > maxChars) {
    throw new RangeError(`${path}.${key} must be ${maxChars} characters or fewer`);
  }
  target[key] = value;
}

function validateRaw(value: unknown, path: string): JsonRecord {
  assertPlainObject(value, path);
  assertJsonValue(value, path, new WeakSet<object>());

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${path} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > RAW_MAX_BYTES) {
    throw new RangeError(`${path} must serialize to ${RAW_MAX_BYTES} bytes or fewer`);
  }

  return value as JsonRecord;
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): void {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must not contain non-finite numbers`);
      }
      return;
    case "object":
      break;
    default:
      throw new TypeError(`${path} must contain only JSON values`);
  }

  if (seen.has(value)) {
    throw new TypeError(`${path} must not contain circular references`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }

  assertPlainObject(value, path);
  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

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
