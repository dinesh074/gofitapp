# gofit.today — current AI architecture

## What exists today

### Provider abstraction
`backend/ai_provider.py` already defines:
- `AIProvider`
- `GeminiProvider`
- `FutureQwenProvider`
- `FutureOpenAIProvider`
- `get_provider()`

This is a good foundation and already aligns with the master prompt’s
replaceable-provider requirement.

### Actual AI usages
Current Gemini-backed surfaces are:
- `/analyze` photo scan
- `/analyze/text` described meal parsing
- optional phrasing in `/foods/recommend`
- optional phrasing in `/meals/verdict`
- optional coach note in `/plan/today`

### Deterministic non-AI surfaces
These do **not** depend on Gemini:
- `/foods/search`
- `/foods/combos`
- `/analyze/barcode`
- progress, wellness, exercise, auth, payments, community

## Current architectural strengths

- AI calls are already centralized behind `ai_provider.get_provider()`.
- Most expensive business logic remains deterministic.
- Packaged-food lookup avoids AI completely.

## Current architectural weaknesses

### Legacy Gemini code still sits in `main.py`
`main.py` still contains:
- direct `google.genai` imports
- `GEN_CONFIG`
- deprecated `get_client()`

Even though `_generate()` now routes through `ai_provider.py`, these legacy
artifacts are still duplication and should eventually be removed.

### Scanner trust model is not yet spec-compliant
The master prompt says:
- AI understands
- deterministic code calculates
- database knows

Current scanner behavior only partially matches that:
- matched items are grounded to `FOOD_DB`
- unmatched items still surface AI-estimated kcal/macros/micros

That is the biggest current AI architecture gap.

### Missing AI subsystems from the target architecture
- structured scan candidate resolver with confidence tiers
- `ai_scan_results`
- `ai_corrections`
- tool-using AI coach
- provider routing by task complexity/cost
- budget alerting / AI observability

## Recommended migration path

1. Keep `ai_provider.py` as the only provider boundary.
2. Move any remaining Gemini config duplication out of `main.py`.
3. Change scanner AI from “authoritative fallback nutrition” toward
   “candidate identification + clarification.”
4. Store scan/correction provenance before increasing graph usage.
5. Only add richer AI coach/tool use after deterministic food/nutrition services
   exist.

## Explicit caution

The next iteration of AI architecture should **reduce** nutritional authority of
the LLM, not increase it. The safe direction is:
- AI suggests candidates
- canonical food graph resolves entities
- deterministic nutrition services calculate values
- AI explains results
