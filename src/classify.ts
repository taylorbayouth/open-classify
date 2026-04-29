import OpenAI from "openai";
import {
  ClassificationSchema,
  type Classification,
  type InputEnvelope,
  type ValidationStatus,
} from "./schema.js";
import { type ClassifierConfig, parseModelString } from "./config.js";

export interface ClassifyAttempt {
  classification: Classification | null;
  validation_status: ValidationStatus;
  latency_ms: number;
  raw_output?: string;
}

const CLASSIFIER_PROMPT = `You are a request classifier. Analyze the user input and respond with ONLY valid JSON.

Required fields (no extras allowed):
- task_class: one of "chat" | "writing" | "code" | "research" | "tool_action" | "planning" | "unknown"
- needs_fresh_info: boolean — true if the request requires current or recently updated information
- needs_private_context: boolean — true if the request requires user-specific data (calendar, email, files, connected accounts)
- needs_side_effect_tool: boolean — true if fulfilling this request causes an external action (send email, create/delete file, post to Slack, deploy, etc.)
- risk: one of "low" | "medium" | "high"
- confidence: number 0–1 representing your confidence in this classification
- reason: string, max 160 characters, explaining the classification

Rules:
- Return ONLY JSON. No markdown, no code fences, no explanation.
- No extra fields beyond the seven listed.
- Use "unknown" for task_class when you cannot confidently classify.
- Keep reason under 160 characters.
- risk "high" = side effects, irreversible changes, credentials, production systems, financial, medical, legal.
- risk "medium" = tools, user data, uncertain claims, reversible changes, code tasks.
- risk "low" = safe informational, creative, or conversational requests.`;

const STRICT_REPAIR_PROMPT = `Return ONLY a JSON object with exactly these fields:
{"task_class":"unknown","needs_fresh_info":false,"needs_private_context":false,"needs_side_effect_tool":false,"risk":"low","confidence":0.5,"reason":""}

Fill in appropriate values for this user input. No markdown. No extra fields.`;

function createClient(config: ClassifierConfig): OpenAI {
  const { provider } = parseModelString(config.model);
  if (provider === "ollama") {
    return new OpenAI({
      baseURL: config.base_url ?? "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  }
  return new OpenAI({ apiKey: config.api_key ?? process.env.OPENAI_API_KEY });
}

function extractJson(text: string): string | null {
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)```/g, "$1").trim();
  if (stripped.startsWith("{")) return stripped;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return null;
}

function tryParse(raw: string): {
  data: Classification | null;
  status: ValidationStatus;
} {
  const extracted = extractJson(raw);
  if (!extracted) return { data: null, status: "invalid_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch {
    return { data: null, status: "invalid_json" };
  }

  const result = ClassificationSchema.safeParse(parsed);
  if (result.success) return { data: result.data, status: "valid" };
  return { data: null, status: "schema_error" };
}

async function callModel(
  systemPrompt: string,
  userInput: string,
  config: ClassifierConfig
): Promise<string> {
  const client = createClient(config);
  const { name: modelName } = parseModelString(config.model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);

  try {
    const response = await client.chat.completions.create(
      {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInput },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      },
      { signal: controller.signal }
    );
    return response.choices[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export async function classifyOnce(
  input: string,
  config: ClassifierConfig,
  repair = false
): Promise<ClassifyAttempt> {
  const start = Date.now();
  const systemPrompt = repair ? STRICT_REPAIR_PROMPT : CLASSIFIER_PROMPT;

  let raw = "";
  try {
    raw = await callModel(systemPrompt, input, config);
  } catch (err) {
    return {
      classification: null,
      validation_status: "classifier_failed",
      latency_ms: Date.now() - start,
      raw_output: String(err),
    };
  }

  const { data, status } = tryParse(raw);
  const finalStatus: ValidationStatus =
    repair && !data ? "classifier_failed" : status;

  return {
    classification: data,
    validation_status: finalStatus,
    latency_ms: Date.now() - start,
    raw_output: raw,
  };
}

export interface ClassifyResult {
  classification: Classification | null;
  validation_status: ValidationStatus;
  latency_ms: number;
  fallback_used: boolean;
}

export async function classify(
  envelope: InputEnvelope,
  config: ClassifierConfig
): Promise<ClassifyResult> {
  const first = await classifyOnce(envelope.user_input, config, false);

  if (first.classification) {
    const belowThreshold =
      first.classification.confidence < config.confidence_threshold;
    if (!belowThreshold) {
      return {
        classification: first.classification,
        validation_status: first.validation_status,
        latency_ms: first.latency_ms,
        fallback_used: false,
      };
    }
  }

  // Retry with repair prompt if first attempt failed or was low-confidence
  const second = await classifyOnce(envelope.user_input, config, true);

  if (second.classification) {
    return {
      classification: second.classification,
      validation_status: first.classification ? "repaired" : second.validation_status,
      latency_ms: first.latency_ms + second.latency_ms,
      fallback_used: false,
    };
  }

  return {
    classification: null,
    validation_status: "classifier_failed",
    latency_ms: first.latency_ms + second.latency_ms,
    fallback_used: true,
  };
}
