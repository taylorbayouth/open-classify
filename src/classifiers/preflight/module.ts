// Preflight classifier manifest. This is the canonical example of the new
// modular framework — every other classifier follows this layout. Adding a
// new short-circuit-capable classifier means creating a sibling directory
// and adding its module to the registry tuple.

import type { ClassifierModule, Contribution } from "../../manifest.js";
import { PREFLIGHT_SYSTEM_PROMPT } from "./prompt.js";
import {
  PREFLIGHT_FALLBACK,
  TERMINALITY_VALUES,
  validatePreflight,
  type PreflightResult,
} from "./result.js";

// Preflight short-circuits the pipeline when the model says the latest user
// message can be answered with a tiny reply on its own — no downstream work
// needed. Lowest priority (= runs first) because terminal verdicts should
// preempt the security check, which is more expensive.
const PREFLIGHT_PRIORITY = 0;

// On the route path (when preflight did not short-circuit), still surface the
// brief acknowledgement reply as an interim UX hint via `handoff.ack_reply`.
// Highest contributor priority (0) — preflight is always the right source of
// an "I'll check" line on this path.
const preflightAckContribution: Contribution<PreflightResult> = {
  slot: "handoff",
  priority: 0,
  build: (result) => {
    if (result.terminality !== "continue") return undefined;
    if (result.reply.trim().length === 0) return undefined;
    return { kind: "route", ack_reply: result.reply };
  },
};

export const preflightModule: ClassifierModule<"preflight", PreflightResult> = {
  name: "preflight",
  version: "1.0.0",
  purpose:
    "Determine whether the latest message can be answered immediately or routed downstream.",
  systemPrompt: PREFLIGHT_SYSTEM_PROMPT,
  validate: validatePreflight,
  fallback: PREFLIGHT_FALLBACK,
  shortCircuit: {
    priority: PREFLIGHT_PRIORITY,
    evaluate: (result) => {
      if (result.terminality !== "terminal") return null;
      if (result.reply.trim().length === 0) return null;
      return { kind: "final", reply: result.reply };
    },
  },
  contributions: [preflightAckContribution],
  backends: {
    ollama: {
      baseModel: "",
      adapterModel: "open-classify-preflight:v0.1.0",
    },
  },
  ui: {
    label: "Preflight",
    optionEnum: TERMINALITY_VALUES,
    renderer: "enum",
  },
};
