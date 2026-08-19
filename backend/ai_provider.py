"""
gofit.today — AI provider abstraction.

Per GOFIT_MASTER_ARCHITECTURE_PROMPT.txt: "Create an AIProvider interface ...
Do not scatter Gemini-specific calls throughout the application." Before this
module, main.py called `google.genai` directly (`get_client()`/`_generate()`).
That was actually the ONLY place in the whole codebase that touched the
Gemini SDK -- verified by grep across backend/ -- so this is a pure
extraction, not a rewrite: same model name, same generation config, same
call sites in main.py, just routed through one interface so a future
Qwen/OpenAI provider is a new class, not a find-and-replace across the app.

Usage (main.py):
    from ai_provider import get_provider
    resp = get_provider().generate(contents)
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod


class AIProvider(ABC):
    """One method every provider must implement: turn a prompt (plus,
    optionally, an image) into a raw response object with a `.text` attribute
    holding the JSON/text payload. Callers (main.py) parse `.text` themselves
    via `extract_json()` -- providers don't parse, they only generate, so
    swapping providers never touches parsing/prompt logic."""

    name: str = "unknown"

    @abstractmethod
    def generate(self, contents):
        """`contents` is either a prompt string, or a [prompt, PIL.Image]
        list for the photo path (same shape main.py already builds)."""
        raise NotImplementedError


class GeminiProvider(AIProvider):
    """Wraps the google-genai SDK. This is the exact logic that used to live
    directly in main.py's get_client()/_generate() -- moved here unchanged."""

    name = "gemini"

    def __init__(self, model: str | None = None):
        from google import genai
        from google.genai import types

        self._genai = genai
        self._types = types
        self.model = model or os.environ.get("FOOD_MODEL", "gemini-3.5-flash-lite")
        self._client = None
        # temperature=0 => deterministic: the same photo yields the same
        # numbers. response_mime_type => strict JSON, no markdown fences.
        # thinking_level="low" => measured ~1.7s vs an erratic 1.7-6.7s
        # without it, no accuracy loss for this single-pass task (see
        # main.py's original comment for the full measurement notes).
        #
        # http_options.timeout: without this the SDK has no client-side
        # cutoff at all -- a slow/stuck Gemini backend could hang the request
        # (and the user's spinner) indefinitely. The Gemini API itself now
        # rejects any deadline below 10s with a 400 INVALID_ARGUMENT ("Manually
        # set deadline Xs is too short. Minimum allowed deadline is 10s.") --
        # this used to be unenforced (9s worked fine) until Google tightened
        # it, which silently broke every single photo/text scan (all 3 retries
        # failed identically since it's a hard validation error, not a
        # transient one). 12s keeps a safety margin above the new 10s floor
        # while still keeping a single stuck attempt from blowing too far past
        # the "3 second rule" scan budget, especially since _run_gemini_analysis
        # retries up to 3x on failure/timeout.
        self.gen_config = types.GenerateContentConfig(
            temperature=0,
            top_p=1,
            response_mime_type="application/json",
            thinking_config=types.ThinkingConfig(thinking_level="low"),
            http_options=types.HttpOptions(timeout=12000),  # ms
        )

    def _client_lazy(self):
        if self._client is None:
            key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
            if not key:
                raise RuntimeError("GEMINI_API_KEY not set")
            self._client = self._genai.Client(api_key=key)
        return self._client

    def generate(self, contents):
        return self._client_lazy().models.generate_content(
            model=self.model, contents=contents, config=self.gen_config
        )


class FutureQwenProvider(AIProvider):
    """Not implemented yet -- placeholder so the interface already has a
    second real implementation slot. See docs/ai-architecture.md for the
    cost/accuracy comparison that would justify actually building this."""

    name = "qwen"

    def __init__(self, *_, **__):
        raise NotImplementedError(
            "Qwen3-VL provider not implemented -- no OpenRouter/Together/Fireworks "
            "API key configured yet. See docs/ai-architecture.md."
        )

    def generate(self, contents):
        raise NotImplementedError


class FutureOpenAIProvider(AIProvider):
    """Not implemented yet -- placeholder for the same reason as
    FutureQwenProvider."""

    name = "openai"

    def __init__(self, *_, **__):
        raise NotImplementedError("OpenAI provider not implemented.")

    def generate(self, contents):
        raise NotImplementedError


_provider: AIProvider | None = None


def get_provider() -> AIProvider:
    """Single entry point the rest of the app should use. Picks the provider
    from AI_PROVIDER env var (default: gemini) -- swapping providers in
    production is a config change, not a code change, once a real
    alternative provider is implemented above."""
    global _provider
    if _provider is None:
        which = os.environ.get("AI_PROVIDER", "gemini").strip().lower()
        if which == "gemini":
            _provider = GeminiProvider()
        elif which == "qwen":
            _provider = FutureQwenProvider()
        elif which == "openai":
            _provider = FutureOpenAIProvider()
        else:
            raise RuntimeError(f"Unknown AI_PROVIDER: {which!r}")
    return _provider
