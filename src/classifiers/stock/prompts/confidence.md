- certainty: required number from 0 to 1.
  Use values near 1 only when the signal is obvious, about 0.75 when confident, about 0.60 when sufficiently supported, about 0.45 when uncertain, and 0.30 or lower when guessing.
  Missing certainty is invalid, and low certainty can cause the runtime to drop your signal, so always emit a real number.
