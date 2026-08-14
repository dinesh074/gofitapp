"""
Deterministic nutrition math shared by scan/search/planning/logging paths.
"""
from __future__ import annotations

from typing import Iterable


_MACROS = ("protein_g", "carbs_g", "fat_g")
_MICROS = ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg")


def _num(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def scale_per_unit_item(item: dict, count: float) -> dict:
    out = dict(item)
    c = max(0.0, _num(count))
    out["count"] = c
    kcal_per = _num(out.get("kcal_per_unit"))
    out["kcal_total"] = round(c * kcal_per)

    for key in _MACROS:
        per_key = f"{key}_per_unit"
        out[per_key] = _num(out.get(per_key, out.get(key, 0)))
        out[key] = round(c * out[per_key], 1)

    micro_totals = {}
    for key in _MICROS:
        per_key = f"{key}_per_unit"
        per_val = out.get(per_key, out.get(key))
        if per_val is None:
            continue
        out[per_key] = _num(per_val)
        out[key] = round(c * out[per_key], 1)
        micro_totals[key] = round(c * out[per_key], 4)

    panel = out.get("micros_per_unit")
    if isinstance(panel, dict):
        out["micros"] = {k: round(_num(v) * c, 4) for k, v in panel.items() if _num(v) >= 0}
    elif micro_totals:
        out["micros"] = micro_totals
    return out


def compute_meal_totals(items: Iterable[dict]) -> dict:
    rows = list(items)
    totals = {
        "kcal": round(sum(_num(it.get("kcal_total")) for it in rows)),
        "protein_g": round(sum(_num(it.get("protein_g")) for it in rows), 1),
        "carbs_g": round(sum(_num(it.get("carbs_g")) for it in rows), 1),
        "fat_g": round(sum(_num(it.get("fat_g")) for it in rows), 1),
    }
    micro_totals: dict[str, float] = {}
    any_estimated = False
    for it in rows:
        panel = it.get("micros")
        if isinstance(panel, dict):
            for k, v in panel.items():
                micro_totals[k] = micro_totals.get(k, 0.0) + _num(v)
        if it.get("micros_source") == "ai_estimated":
            any_estimated = True
    if micro_totals:
        totals["micros"] = {k: round(v, 4) for k, v in micro_totals.items()}
        totals["micros_estimated"] = any_estimated
    return totals

