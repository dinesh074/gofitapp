"""
Baseline contract harness for canonical /foods/search parity checks.

Run:
  python validate_food_graph_contract.py
"""
from __future__ import annotations

import json
import os
import sys

import food_graph


BASELINE_CASES = [
    ("idli", "search_idli.json"),
    ("paneer", "search_paneer.json"),
    ("mutton", "search_mutton.json"),
]


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _keys(results: list[dict], limit: int) -> list[str]:
    out = []
    for r in results[:limit]:
        key = r.get("key")
        if isinstance(key, str) and key:
            out.append(key)
    return out


def main() -> int:
    root = os.path.dirname(os.path.abspath(__file__))
    baseline_dir = os.path.join(root, "_contract_baseline")
    food_graph.init_db()

    failures: list[str] = []
    for query, filename in BASELINE_CASES:
        baseline = _load_json(os.path.join(baseline_dir, filename))
        expected = _keys(baseline.get("results", []), 5)
        actual_rows = food_graph.search_foods(query, limit=5)
        actual = [food_graph.compatibility_food_suggestion(r) for r in actual_rows]
        got = _keys(actual, 5)

        if not expected:
            failures.append(f"{query}: baseline has no expected keys")
            continue
        if not got:
            failures.append(f"{query}: canonical search returned no results")
            continue
        if expected[0] != got[0]:
            failures.append(
                f"{query}: top result mismatch expected={expected[0]} got={got[0]}"
            )
        overlap = len(set(expected) & set(got))
        if overlap < 2:
            failures.append(
                f"{query}: low overlap expected={expected} got={got}"
            )

    if failures:
        print("FAIL canonical parity checks")
        for line in failures:
            print("-", line)
        return 1

    print("PASS canonical parity checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())

