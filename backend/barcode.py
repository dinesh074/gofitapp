"""
gofit.today — barcode lookup for packaged foods.

POST /analyze/barcode  {code: "<EAN/UPC digits>"}  -> AnalysisResult JSON

Why this is a SEPARATE path from /analyze (photo) and /analyze/text:

  A barcode is a deterministic lookup against a public product database
  (OpenFoodFacts), NOT a Gemini call. It costs us nothing to serve and the
  nutrition it returns comes straight off the packaging label. So, unlike the
  AI paths, it deliberately does NOT go through _require_scan_slot / does NOT
  reserve or consume a free-scan credit -- scanning a barcode is free and
  uncounted. Only real AI analysis (photo/text) spends the credit that the
  paywall meters. This is the whole point of keeping it here rather than
  bolting a `source="barcode"` flag onto the AI endpoints.

Response shape is byte-for-byte the same AnalysisResult the client already
renders for photo/text (dish, cuisine, items[], calories_kcal, confidence,
totals), so the existing result card, portion +/- stepper and "Add to day"
flow work unchanged. When the barcode isn't in the database we return 404 so
the client can fall back to a photo/text scan.
"""
import json
import logging
import urllib.request
import urllib.error

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import auth

log = logging.getLogger("gofit.barcode")

router = APIRouter(tags=["barcode"])

# OpenFoodFacts asks every API client to identify itself with a descriptive
# User-Agent (unidentified traffic can be rate-limited/blocked).
# .net is tried first because the .org production API has recurring 502 outages
# that were making barcode scans hard-fail; .org is kept as a same-API fallback
# so a scan still resolves if .net is ever unreachable.
_OFF_HOSTS = ("world.openfoodfacts.net", "world.openfoodfacts.org")
_OFF_URL = "https://{host}/api/v2/product/{code}.json"
_OFF_FIELDS = (
    "product_name,brands,serving_size,serving_quantity,nutriments,"
    "quantity,categories_tags,countries_tags,alcohol"
)
_USER_AGENT = "gofit.today/1.0 (barcode lookup; contact: info@buiild.in)"
_TIMEOUT = 8  # seconds -- keep the request snappy; OFF is usually sub-second


class BarcodeBody(BaseModel):
    # EAN-8/EAN-13/UPC-A/UPC-E are 8-14 digits. Reject anything that isn't a
    # plausible barcode before spending a network round-trip on it.
    code: str = Field(..., min_length=6, max_length=18)


def _digits(code: str) -> str:
    return "".join(ch for ch in code if ch.isdigit())


def _num(nutriments: dict, *keys) -> float:
    """First present, numeric value among `keys` (0.0 if none)."""
    for k in keys:
        v = nutriments.get(k)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                continue
    return 0.0


def _fetch_off_host(host: str, code: str) -> dict | None:
    """Query one OpenFoodFacts host. Returns the product dict, None if the code
    is unknown (404 / status 0), or raises _OffUnavailable if the host itself is
    unreachable/erroring so the caller can try the next host."""
    url = _OFF_URL.format(host=host, code=code) + "?fields=" + _OFF_FIELDS
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as ex:
        if ex.code == 404:
            return None
        log.warning("OFF HTTP error for %s on %s: %s", code, host, ex)
        raise _OffUnavailable(str(ex))
    except Exception as ex:
        log.warning("OFF lookup failed for %s on %s: %s", code, host, ex)
        raise _OffUnavailable(str(ex))
    # OFF returns status 0 with no usable product when the code is unknown.
    if not body or body.get("status") == 0 or not body.get("product"):
        return None
    return body["product"]


class _OffUnavailable(Exception):
    """A given OpenFoodFacts host couldn't serve the request (down/errored)."""


def _fetch_off(code: str) -> dict | None:
    """Return the OpenFoodFacts product dict, or None if not found.

    Tries .net first, then falls back to .org when .net is unreachable (the .org
    production API has recurring 502 outages). A definitive "not found" from any
    reachable host short-circuits -- we only move on when a host is actually
    down. If every host is unavailable, surface a 502."""
    last_error: str | None = None
    for host in _OFF_HOSTS:
        try:
            return _fetch_off_host(host, code)
        except _OffUnavailable as ex:
            last_error = str(ex)
            continue
    raise HTTPException(
        status_code=502,
        detail="Couldn't reach the barcode database. Try again.",
    )


def _sanity_issues(kcal, protein, carbs, fat, fiber, sugar, alcohol=0.0) -> list[str]:
    """Physical-plausibility checks on a per-100g nutrient row. Returns a list of
    human-readable issues; empty means the label looks trustworthy.

    OpenFoodFacts is crowd-sourced, so some products carry impossible values
    (macros summing past the food's own mass, calories that don't match the
    macros, fibre/sugar exceeding total carbohydrate). We use these to demote
    confidence rather than present garbage as near-certain."""
    issues: list[str] = []
    # Macronutrients are a subset of 100 g of food; allow a little slack for
    # rounding and water/ash, but a sum well past 100 g is impossible.
    if protein + carbs + fat > 105.0:
        issues.append("macros exceed 100 g/100 g")
    # Pure fat is ~884 kcal/100 g; nothing edible exceeds ~900.
    if kcal > 902.0:
        issues.append("calories exceed physical maximum")
    # Fibre and sugar are components of carbohydrate; they can't exceed it
    # (small tolerance for label rounding).
    if fiber > carbs + 1.0:
        issues.append("fibre exceeds carbohydrate")
    if sugar > carbs + 1.0:
        issues.append("sugar exceeds carbohydrate")
    # Atwater: calories implied by the macros should roughly match the declared
    # calories. Alcohol (7 kcal/g) carries energy but isn't a macro, so include
    # it -- otherwise spirits would look like "calories from nothing". Judge only
    # when at least one side is substantial, so trace-calorie products (diet
    # drinks, water) aren't flagged on rounding noise.
    atwater = 4.0 * protein + 4.0 * carbs + 9.0 * fat + 7.0 * alcohol
    if kcal > 50.0 or atwater > 50.0:
        ratio = kcal / max(atwater, 1.0)
        if ratio < 0.6 or ratio > 1.6:
            issues.append("calories disagree with macros")
    return issues


def _build_result(product: dict) -> dict:
    """Map an OpenFoodFacts product to the app's AnalysisResult shape.

    Packaged-food labels are given per-100g; many also carry per-serving
    figures. We anchor one FoodItem to a single serving when the pack declares
    one (so the +/- stepper adds whole servings), otherwise to 100 g.

    Before trusting a per-serving basis we sanity-check the label: if the
    per-100g row is physically implausible (bad crowd-sourced data), we fall
    back to the 100 g basis and lower the confidence so obviously-wrong entries
    aren't presented as near-certain."""
    n = product.get("nutriments") or {}
    name = (product.get("product_name") or "").strip()
    brand = (product.get("brands") or "").split(",")[0].strip()
    if not name:
        name = brand or "Packaged food"
    dish = f"{brand} {name}".strip() if brand and brand.lower() not in name.lower() else name

    # Per-100g row -- the canonical basis and what we sanity-check against.
    kcal_100 = _num(n, "energy-kcal_100g")
    protein_100 = _num(n, "proteins_100g")
    carbs_100 = _num(n, "carbohydrates_100g")
    fat_100 = _num(n, "fat_100g")
    fiber_100 = _num(n, "fiber_100g")
    sugar_100 = _num(n, "sugars_100g")
    sodium_100 = _num(n, "sodium_100g")
    alcohol_100 = _num(n, "alcohol_100g")

    issues = _sanity_issues(
        kcal_100, protein_100, carbs_100, fat_100, fiber_100, sugar_100, alcohol_100
    )

    serving_g = product.get("serving_quantity")
    try:
        serving_g = float(serving_g) if serving_g not in (None, "") else 0.0
    except (TypeError, ValueError):
        serving_g = 0.0

    # Use the per-serving basis only when the label is trustworthy. If the data
    # failed the sanity checks, anchor to 100 g so we don't multiply bad numbers
    # by a (possibly also bad) serving size.
    if serving_g and serving_g > 0 and not issues:
        factor = serving_g / 100.0
        unit = f"serving ({serving_g:g} g)"
        kcal = _num(n, "energy-kcal_serving") or kcal_100 * factor
        protein = _num(n, "proteins_serving") or protein_100 * factor
        carbs = _num(n, "carbohydrates_serving") or carbs_100 * factor
        fat = _num(n, "fat_serving") or fat_100 * factor
        fiber = _num(n, "fiber_serving") or fiber_100 * factor
        sugar = _num(n, "sugars_serving") or sugar_100 * factor
        sodium_g = _num(n, "sodium_serving") or sodium_100 * factor
    else:
        unit = "100 g"
        kcal = kcal_100
        protein = protein_100
        carbs = carbs_100
        fat = fat_100
        fiber = fiber_100
        sugar = sugar_100
        sodium_g = sodium_100

    # Fibre/sugar are components of carbohydrate; never let a bad label report
    # more than the carbohydrate total for the same basis.
    fiber = min(fiber, carbs) if carbs else fiber
    sugar = min(sugar, carbs) if carbs else sugar

    # OFF stores sodium in grams; the app tracks it in mg.
    sodium_mg = round(sodium_g * 1000.0, 1)

    item = {
        "item": name,
        "count": 1,
        "unit": unit,
        "countable": True,
        "kcal_per_unit": round(kcal, 1),
        "protein_g_per_unit": round(protein, 1),
        "carbs_g_per_unit": round(carbs, 1),
        "fat_g_per_unit": round(fat, 1),
        "protein_g": round(protein, 1),
        "carbs_g": round(carbs, 1),
        "fat_g": round(fat, 1),
        "kcal_total": round(kcal),
        "source": "barcode",
    }
    # Only attach micros that the label actually reported (never guess).
    if fiber:
        item["fiber_g"] = round(fiber, 1)
    if sugar:
        item["sugar_g"] = round(sugar, 1)
    if sodium_mg:
        item["sodium_mg"] = sodium_mg

    totals = {
        "kcal": item["kcal_total"],
        "protein_g": item["protein_g"],
        "carbs_g": item["carbs_g"],
        "fat_g": item["fat_g"],
    }
    if issues:
        log.warning("OFF data for %r looks implausible (%s)", dish, "; ".join(issues))
    return {
        "dish": dish,
        "cuisine": "Packaged",
        "items": [item],
        "calories_kcal": item["kcal_total"],
        # Barcode data is normally read straight off the label, so the reading is
        # exact -- the only uncertainty is whether the user eats one serving. But
        # when the crowd-sourced label failed our sanity checks, flag it as much
        # less certain so the UI/user treats the numbers with suspicion.
        "confidence": 0.55 if issues else 0.99,
        "totals": totals,
    }


@router.post("/analyze/barcode")
def analyze_barcode(body: BarcodeBody, request: Request):
    """Look up a packaged product by barcode. Requires a signed-in account (so
    it behaves like the other logging paths) but does NOT reserve or consume a
    free-scan credit -- barcode lookups are free and uncounted."""
    auth.require_account(request)
    code = _digits(body.code)
    if len(code) < 8:
        raise HTTPException(status_code=400, detail="That doesn't look like a valid barcode.")

    product = _fetch_off(code)
    if product is None:
        # 404 => client falls back to a photo/text scan for this item.
        raise HTTPException(
            status_code=404,
            detail="We couldn't find that barcode. Try a photo of the label instead.",
        )

    result = _build_result(product)
    if result["calories_kcal"] <= 0:
        # Found the product but it has no usable nutrition on file.
        raise HTTPException(
            status_code=404,
            detail="That product has no nutrition data on file. Try a photo instead.",
        )
    return result
