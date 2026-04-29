import type { Classification, RouteDecision } from "./schema.js";
import type { HarnessConfig } from "./config.js";

export function computeRoute(
  classification: Classification | null,
  config: HarnessConfig
): RouteDecision {
  const { routing } = config;

  // Classifier failed — safe fallback
  if (!classification) {
    return {
      route: "fallback",
      model_tier: routing.default_model_tier,
      requires_confirmation: false,
      requires_web: false,
      requires_private_context: false,
    };
  }

  const {
    task_class,
    needs_side_effect_tool,
    needs_fresh_info,
    needs_private_context,
    risk,
  } = classification;

  // Side effects always require confirmation regardless of risk
  if (needs_side_effect_tool) {
    return {
      route: "confirm_side_effect",
      model_tier: risk === "high" ? routing.high_risk_model_tier : routing.default_model_tier,
      requires_confirmation: true,
      requires_web: needs_fresh_info,
      requires_private_context: needs_private_context,
    };
  }

  // High risk without side effects → escalate to frontier and flag
  if (risk === "high") {
    return {
      route: "frontier",
      model_tier: routing.high_risk_model_tier,
      requires_confirmation: true,
      requires_web: needs_fresh_info,
      requires_private_context: needs_private_context,
    };
  }

  // Fresh info needed
  if (needs_fresh_info) {
    return {
      route: "web",
      model_tier: routing.research_model_tier,
      requires_confirmation: false,
      requires_web: true,
      requires_private_context: needs_private_context,
    };
  }

  // Private context needed
  if (needs_private_context) {
    return {
      route: "private_context",
      model_tier: routing.default_model_tier,
      requires_confirmation: false,
      requires_web: false,
      requires_private_context: true,
    };
  }

  // Task-class specific routing
  if (task_class === "research") {
    return {
      route: "frontier",
      model_tier: routing.research_model_tier,
      requires_confirmation: false,
      requires_web: false,
      requires_private_context: false,
    };
  }

  if (task_class === "planning") {
    return {
      route: "cheap",
      model_tier: routing.planning_model_tier,
      requires_confirmation: false,
      requires_web: false,
      requires_private_context: false,
    };
  }

  if (task_class === "code") {
    return {
      route: "cheap",
      model_tier: routing.code_model_tier,
      requires_confirmation: false,
      requires_web: false,
      requires_private_context: false,
    };
  }

  // Default: cheap route for chat, writing, unknown
  return {
    route: "cheap",
    model_tier: routing.default_model_tier,
    requires_confirmation: false,
    requires_web: false,
    requires_private_context: false,
  };
}
