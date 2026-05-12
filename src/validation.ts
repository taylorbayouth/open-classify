// Backend-neutral validation helpers used by every classifier module's
// `validate` function. These exist because hand-rolled validation gives us
// precise error messages and full control over the failure mode, without
// pulling in a dependency.
//
// Each helper takes the value, the classifier name, the backend model id
// (for error messages), and a JSON path. On failure it throws a
// `ClassifierValidationError` — backends catch that boundary and convert it
// to their own error type if they want a richer one (e.g. the Ollama runner
// wraps it as `OllamaClassifierError`).

// Thrown by every helper here. Carries the classifier name and the backend
// model id so backend-specific runners can wrap or report cleanly.
export class ClassifierValidationError extends Error {
  readonly classifier: string;
  readonly model: string;
  constructor(classifier: string, model: string, message: string) {
    super(message);
    this.name = "ClassifierValidationError";
    this.classifier = classifier;
    this.model = model;
  }
}

export function throwInvalid(
  classifier: string,
  model: string,
  message: string,
): never {
  throw new ClassifierValidationError(
    classifier,
    model,
    `${classifier} classifier returned invalid output: ${message}`,
  );
}

export function requireString(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
): string {
  if (typeof value !== "string") {
    throwInvalid(classifier, model, `${path} must be a string`);
  }
  return value;
}

export function requireBoolean(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
): boolean {
  if (typeof value !== "boolean") {
    throwInvalid(classifier, model, `${path} must be a boolean`);
  }
  return value;
}

export function requireNonNegativeSafeInteger(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throwInvalid(classifier, model, `${path} must be a non-negative safe integer`);
  }
  return value;
}

export function requireStringArray(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throwInvalid(classifier, model, `${path} must be an array of strings`);
  }
  return value;
}

export function requireStringMaxLength(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
  maxChars: number,
): string {
  const text = requireString(value, classifier, model, path);
  if (text.length > maxChars) {
    throwInvalid(classifier, model, `${path} must be ${maxChars} characters or fewer`);
  }
  return text;
}

export function requireNonEmptyStringMaxLength(
  value: unknown,
  classifier: string,
  model: string,
  path: string,
  maxChars: number,
): string {
  const text = requireStringMaxLength(value, classifier, model, path, maxChars);
  if (text.trim().length === 0) {
    throwInvalid(classifier, model, `${path} must not be empty`);
  }
  return text;
}

export function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  classifier: string,
  model: string,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throwInvalid(classifier, model, `${path} has an unsupported value`);
  }
  return value;
}

// `confidence` must be a finite number in [0, 1]. Required on every
// classifier output (ClassifierResultBase); fallback shapes use 0.
export function requireConfidence(
  value: unknown,
  classifier: string,
  model: string,
  path = "confidence",
): number {
  const confidence = normalizeConfidence(value);
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throwInvalid(classifier, model, `${path} must be a number between 0 and 1 inclusive`);
  }
  return confidence;
}

function normalizeConfidence(value: unknown): unknown {
  if (typeof value === "number") {
    return value > 1 && value <= 100 ? value / 100 : value;
  }
  if (typeof value !== "string") return value;

  const text = value.trim().toLowerCase();
  if (text === "") return value;
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1).trim());
    return Number.isFinite(percent) ? percent / 100 : value;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 1 && numeric <= 100 ? numeric / 100 : numeric;
  }

  if (text === "high") return 0.9;
  if (text === "medium") return 0.5;
  if (text === "low") return 0.2;
  return value;
}

export function ensureExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  classifier: string,
  model: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throwInvalid(classifier, model, `${key} is not a supported field`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throwInvalid(classifier, model, `${key} is required`);
    }
  }
}

export function ensureNoDuplicates(
  values: string[],
  classifier: string,
  model: string,
  path: string,
): void {
  if (new Set(values).size !== values.length) {
    throwInvalid(classifier, model, `${path} must not include duplicates`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
