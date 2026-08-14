"""
Deterministic dietary rule checks.
"""
from __future__ import annotations


_VALID_DIETS = {"veg", "vegan", "eggetarian", "nonveg", "jain", "sattvic"}


def normalize_diet(value: str) -> str:
    d = (value or "veg").strip().lower()
    return d if d in _VALID_DIETS else "veg"


def food_allowed(food: dict, diet: str) -> bool:
    d = normalize_diet(diet)
    if d == "nonveg":
        return True
    text = " ".join(
        str(x).lower()
        for x in [
            food.get("name", ""),
            food.get("key", ""),
            " ".join(food.get("aliases", []) or []),
        ]
        if x
    )
    if d == "vegan":
        blocked = ("chicken", "mutton", "fish", "egg", "paneer", "milk", "curd", "ghee", "cheese", "butter")
        return not any(w in text for w in blocked)
    if d == "eggetarian":
        blocked = ("chicken", "mutton", "fish", "prawn", "beef", "pork")
        return not any(w in text for w in blocked)
    if d == "jain":
        status = (food.get("jain_status") or "").lower()
        return status in ("yes", "depends", "")
    if d == "sattvic":
        status = (food.get("sattvic_status") or "").lower()
        return status in ("yes", "depends", "")
    blocked = ("chicken", "mutton", "fish", "prawn", "beef", "pork", "egg")
    return not any(w in text for w in blocked)

