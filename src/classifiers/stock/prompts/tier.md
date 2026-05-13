- model_tier: "local_fast", "local_small", "local_strong", "local_coding", "frontier_fast", "frontier_strong", or "frontier_coding"

Use local tiers for short, low-stakes, or self-contained requests.
Use frontier tiers for high-stakes, ambiguous, multi-step, or complex requests.
Use *_coding tiers when the request is implementation-heavy or code quality matters materially.
Prefer the weakest tier that should still succeed.
Omit model_tier when you cannot pick with reasonable certainty.
