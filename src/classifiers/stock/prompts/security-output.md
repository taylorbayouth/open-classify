Emit the safety verdict directly as top-level fields:

- decision: optional "allow", "block", or "needs_review"
- risk_level: "normal", "suspicious", "high_risk", or "unknown"
- signals: short string identifiers for concrete safety signals

normal and unknown must use an empty signals array. suspicious and high_risk must include at least one signal.
Use decision "block" only with high_risk. Use "needs_review" when the caller should clarify, escalate, or fail closed.
