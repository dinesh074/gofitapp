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
# Production is tried first; staging (.net) is a same-API fallback used only when
# production is unreachable (e.g. the recurring .org 502 outages), so a barcode
# scan still resolves instead of hard-failing.
_OFF_HOSTS = ("world.openfoodfacts.org", "world.openfoodfacts.net")
_OFF_URL = "https://{host}/api/v2/product/{code}.json"
_OFF_FIELDS = (
    "product_name,brands,serving_size,serving_quantity,nutriments,"
    "quantity,categories_tags,countries_tags"
)
_USER_AGENT = "gofit.today/1.0 (barcode lookup; contact: support@gofit.today)"
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

    Tries production first, then falls back to staging when production is
    unreachable (the .org API has recurring 502 outages). A definitive
    "not found" from any reachable host short-circuits -- we only move on when a
    host is actually down. If every host is unavailable, surface a 502."""
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


def _build_result(product: dict) -> dict:
    """Map an OpenFoodFacts product to the app's AnalysisResult shape.

    Packaged-food labels are given per-100g; many also carry per-serving
    figures. We anchor one FoodItem to a single serving when the pack declares
    one (so the +/- stepper adds whole servings), otherwise to 100 g."""
    n = product.get("nutriments") or {}
    name = (product.get("product_name") or "").strip()
    brand = (product.get("brands") or "").split(",")[0].strip()
    if not name:
        name = brand or "Packaged food"
    dish = f"{brand} {name}".strip() if brand and brand.lower() not in name.lower() else name

    serving_g = product.get("serving_quantity")
    try:
        serving_g = float(serving_g) if serving_g not in (None, "") else 0.0
    except (TypeError, ValueError):
        serving_g = 0.0

    # Prefer explicit per-serving values from the label; else scale per-100g.
    if serving_g and serving_g > 0:
        factor = serving_g / 100.0
        unit = f"serving ({serving_g:g} g)"
        kcal = _num(n, "energy-kcal_serving") or _num(n, "energy-kcal_100g") * factor
        protein = _num(n, "proteins_serving") or _num(n, "proteins_100g") * factor
        carbs = _num(n, "carbohydrates_serving") or _num(n, "carbohydrates_100g") * factor
        fat = _num(n, "fat_serving") or _num(n, "fat_100g") * factor
        fiber = _num(n, "fiber_serving") or _num(n, "fiber_100g") * factor
        sugar = _num(n, "sugars_serving") or _num(n, "sugars_100g") * factor
        sodium_g = _num(n, "sodium_serving") or _num(n, "sodium_100g") * factor
    else:
        unit = "100 g"
        kcal = _num(n, "energy-kcal_100g")
        protein = _num(n, "proteins_100g")
        carbs = _num(n, "carbohydrates_100g")
        fat = _num(n, "fat_100g")
        fiber = _num(n, "fiber_100g")
        sugar = _num(n, "sugars_100g")
        sodium_g = _num(n, "sodium_100g")

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
    return {
        "dish": dish,
        "cuisine": "Packaged",
        "items": [item],
        "calories_kcal": item["kcal_total"],
        # Barcode data is read straight off the label, so the reading itself is
        # exact -- the only uncertainty is whether the user eats one serving.
        "confidence": 0.99,
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
