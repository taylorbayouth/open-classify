import { CLASSIFIER_NAMES } from "./classifiers.js";
import { normalizeOpenClassifyInput, toClassifierInput } from "./input.js";
import type {
  ClassifierName,
  ClassifierOutput,
  NormalizedOpenClassifyInput,
  OpenClassifyInput,
  OpenClassifyPipelineResult,
  OpenClassifyResult,
  PreflightResult,
  RunClassifier,
} from "./types.js";

export class OpenClassifyNormalizationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "OpenClassifyNormalizationError";
    this.cause = cause;
  }
}

export class OpenClassifyClassifierError extends Error {
  readonly classifier: ClassifierName;
  readonly request: NormalizedOpenClassifyInput;
  readonly cause: unknown;

  constructor(
    classifier: ClassifierName,
    request: NormalizedOpenClassifyInput,
    cause: unknown,
  ) {
    super(`${classifier} classifier failed: ${errorMessage(cause)}`);
    this.name = "OpenClassifyClassifierError";
    this.classifier = classifier;
    this.request = request;
    this.cause = cause;
  }
}

export interface ClassifyOptions {
  runClassifier: RunClassifier;
}

type SettledClassifierResult<Name extends ClassifierName> =
  | {
      ok: true;
      name: Name;
      value: ClassifierOutput<Name>;
    }
  | {
      ok: false;
      name: Name;
      error: unknown;
    };

export async function classifyOpenClassifyInput(
  input: OpenClassifyInput,
  options: ClassifyOptions,
): Promise<OpenClassifyPipelineResult> {
  let request: NormalizedOpenClassifyInput;
  try {
    request = normalizeOpenClassifyInput(input);
  } catch (error) {
    throw new OpenClassifyNormalizationError(error);
  }

  const controller = new AbortController();
  const classifierInput = toClassifierInput(request);
  const runs = new Map(
    CLASSIFIER_NAMES.map((name) => [
      name,
      settleClassifier(
        name,
        options.runClassifier(name, classifierInput, controller.signal),
      ),
    ]),
  );

  const preflight = await unwrapClassifierResult(
    runs.get("preflight") as Promise<SettledClassifierResult<"preflight">>,
    request,
  );

  if (preflight.terminality === "terminal") {
    controller.abort();
    observeNonPreflightRuns(runs);

    return {
      status: "terminal",
      request,
      preflight,
    };
  }

  const settled = await Promise.all(
    CLASSIFIER_NAMES.map((name) => runs.get(name)!),
  );

  const firstFailure = settled.find((entry) => !entry.ok);
  if (firstFailure && !firstFailure.ok) {
    throw new OpenClassifyClassifierError(
      firstFailure.name,
      request,
      firstFailure.error,
    );
  }

  const results = settled.map((entry) => (entry as { ok: true; value: unknown }).value);

  const classifiers: OpenClassifyResult = {
    preflight: results[0] as PreflightResult,
    downstream_route: results[1] as OpenClassifyResult["downstream_route"],
    additional_history_need: results[2] as OpenClassifyResult["additional_history_need"],
    memory_retrieval_queries: results[3] as OpenClassifyResult["memory_retrieval_queries"],
    tool_family_need: results[4] as OpenClassifyResult["tool_family_need"],
    message_and_attachment_digest: results[5] as OpenClassifyResult["message_and_attachment_digest"],
    security_posture: results[6] as OpenClassifyResult["security_posture"],
  };

  return {
    status: "continue",
    request,
    awk: classifiers.preflight.awk,
    classifiers,
  };
}

function settleClassifier<Name extends ClassifierName>(
  name: Name,
  run: Promise<ClassifierOutput<Name>>,
): Promise<SettledClassifierResult<Name>> {
  return run.then(
    (value) => ({ ok: true, name, value }),
    (error: unknown) => ({ ok: false, name, error }),
  );
}

async function unwrapClassifierResult<Name extends ClassifierName>(
  result: Promise<SettledClassifierResult<Name>> | undefined,
  request: NormalizedOpenClassifyInput,
): Promise<ClassifierOutput<Name>> {
  if (result === undefined) {
    throw new Error("internal classifier run missing");
  }

  const settled = await result;
  if (settled.ok) {
    return settled.value;
  }

  throw new OpenClassifyClassifierError(settled.name, request, settled.error);
}

function observeNonPreflightRuns(
  runs: ReadonlyMap<ClassifierName, Promise<SettledClassifierResult<ClassifierName>>>,
): void {
  for (const [name, run] of runs) {
    if (name !== "preflight") {
      void run;
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
