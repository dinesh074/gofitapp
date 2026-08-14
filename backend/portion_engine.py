"""
Shared portion scaling helpers.
"""
from __future__ import annotations


def clamp_count(count: float, *, minimum: float = 0.5, maximum: float = 50.0, step: float = 0.5) -> float:
    c = float(count)
    c = min(maximum, max(minimum, c))
    return round(c / step) * step


def apply_multiplier(item: dict, multiplier: float) -> dict:
    out = dict(item)
    m = max(0.0, float(multiplier))
    for key in ("kcal_per_unit", "protein_g_per_unit", "carbs_g_per_unit", "fat_g_per_unit"):
        if key in out and isinstance(out[key], (int, float)):
            out[key] = float(out[key]) * m
    for key in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg"):
        if key in out and isinstance(out[key], (int, float)):
            out[key] = float(out[key]) * m
    if isinstance(out.get("micros_per_unit"), dict):
        out["micros_per_unit"] = {
            k: (float(v) * m if isinstance(v, (int, float)) else v)
            for k, v in out["micros_per_unit"].items()
        }
    return out

