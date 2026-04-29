import type { Classification, RouteDecision } from "./schema.js";
import type { HarnessConfig } from "./config.js";

export function computeRoute(
  classification: Classification | null,
  config: HarnessConfig
): RouteDecision {
  const { routing } = config;

  // Classifier failed entirely → fallback
  if (!classification) {
    return {
      route: "fallback",
      requires_confirmation: false,
      tools_required: false,
      memory_scope: "none",
      escalated: false,
      escalation_reason: null,
    };
  }

  const c = classification;

  // Hard reject on prompt injection
  if (c.security === "prompt_injection") {
    return {
      route: "reject",
      requires_confirmation: true,
      tools_required: c.tools_required,
      memory_scope: c.needs_memory,
      escalated: true,
      escalation_reason: "prompt_injection",
    };
  }

  // Low confidence → escalate to frontier regardless of suggested_model
  const lowAvg = c.average_confidence < routing.avg_confidence_threshold;
  const lowMin = c.min_confidence < routing.min_confidence_threshold;
  if (lowAvg || lowMin) {
    return {
      route: "billed_frontier",
      requires_confirmation: false,
      tools_required: c.tools_required,
      memory_scope: c.needs_memory,
      escalated: true,
      escalation_reason: "low_confidence",
    };
  }

  // Suspicious → escalate with confirmation
  if (c.security === "suspicious") {
    return {
      route: "billed_frontier",
      requires_confirmation: true,
      tools_required: c.tools_required,
      memory_scope: c.needs_memory,
      escalated: true,
      escalation_reason: "suspicious",
    };
  }

  // Default: trust the suggested_model
  return {
    route: c.suggested_model,
    requires_confirmation: false,
    tools_required: c.tools_required,
    memory_scope: c.needs_memory,
    escalated: false,
    escalation_reason: null,
  };
}
