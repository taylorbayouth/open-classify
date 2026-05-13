Emit the safety verdict directly as top-level fields:

- risk_level: "normal", "suspicious", "high_risk", or "unknown"
- signals: short string identifiers for concrete safety signals

normal and unknown must use an empty signals array. suspicious and high_risk must include at least one signal.
Use high_risk when the request should be blocked. Use unknown when safety cannot be established.
