- confidence: JSON number float from 0.0 to 1.0 inclusive (do not use percent, string, or label).
  Use 0.9 when you are confident, 0.7 when you are reasonably sure, 0.5 when uncertain, 0.2 when guessing.
  A missing or zero confidence causes the runtime to drop your signal, so always emit a real value.
