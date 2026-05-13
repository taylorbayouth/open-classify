- certainty: required. Use one of "no_signal", "very_weak", "weak", "tentative", "reasonable", "strong", "very_strong", or "near_certain".
  Use "near_certain" only when the signal is obvious, "strong" when confident, "reasonable" when sufficiently supported, "tentative" when uncertain, and "weak" or lower when guessing.
  The runtime maps this tag to a numeric score for aggregation. Missing certainty is invalid, and low certainty can cause the runtime to drop your signal, so always emit a real tag.
