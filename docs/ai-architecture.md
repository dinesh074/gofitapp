# gofit.today — AI Architecture

## What existed before this cycle
`backend/main.py` called the `google-genai` SDK directly (`get_client()` /
`_generate()`), and that was verified (via grep across the whole `backend/`
directory) to be the **only** place in the codebase touching Gemini. No
scattering problem existed to fix at the call-site level -- but there was
also no interface, so a future provider swap would have meant editing
`main.py` itself rather than adding a class.

## What changed this cycle
- New `backend/ai_provider.py`: an `AIProvider` abstract base class with one
  method, `generate(contents)`. Implementations:
  - `GeminiProvider` — the exact same client/config/model logic that used to
    live inline in `main.py`, moved here unchanged (same `temperature=0`,
    same `thinking_level="low"`, same `FOOD_MODEL` env var).
  - `FutureQwenProvider`, `FutureOpenAIProvider` — explicit placeholders that
    raise `NotImplementedError` with a pointer to this doc. Not fake/stub
    implementations that silently do nothing — they fail loudly if selected
    before being built.
- `get_provider()` picks the active provider from `AI_PROVIDER` env var
  (default `gemini`). Swapping providers in production, once a real
  alternative exists, becomes a config change.
- `main.py`'s `_generate()` now calls `ai_provider.get_provider().generate(contents)`
  instead of the SDK directly. All existing call sites (`/analyze`,
  `/analyze/text`, `/foods/recommend`, `/meals/verdict`) are unchanged --
  this was a pure extraction, verified via `python -c "import main"` after
  the change (no import errors, no behavior change).

## Cost/accuracy research already done (see prior session)
- Gemini 3.5 Flash-Lite: $0.30 / $2.50 per 1M input/output tokens (current
  production model, on the free tier today -- actual cost is $0).
- Qwen3-VL-8B-Instruct via OpenRouter: $0.117 / $0.455 per 1M -- a real
  *new* cost, not a saving, since the app isn't paying for Gemini today.
- Qwen3-VL-2B is not available on any pay-per-token hosted API found
  (self-host only).
- Conclusion at the time: switching providers is justified by accuracy, not
  cost, and needs a real side-by-side test before committing -- blocked on
  an OpenRouter/Together/Fireworks API key the user hadn't provided yet.
  `FutureQwenProvider` exists now specifically so that test can be wired in
  later without touching `main.py` again.

## Cost control (per spec, not yet built)
Routing "simple -> Flash-Lite, complex/vision -> Flash, low confidence ->
fallback" and a monthly AI budget threshold are not implemented yet -- only
one model is used today (`FOOD_MODEL` env var, single value). Flagged as a
later-month task, not done in this cycle.
