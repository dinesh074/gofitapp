"""
gofit.today — Free / Pro entitlements.

This is the single source of truth for what a Free account can do versus a Pro
account. The product rule (see the spec) is: entitlements live at the
product/backend level, NOT as hidden UI. So:

  * every gated capability is a named FEATURE with a tier (free / pro),
  * the client asks GET /entitlements for the account's resolved state and uses
    it to decide what to show AND to explain the paywall honestly, and
  * server actions that actually cost us money (the AI calls) can be hard-gated
    with require_pro(...), so a crafted client can't bypass the paywall.

Pro status itself is stored on accounts.is_pro (set by payments.py after a
verified Razorpay payment). The free-scan trial (auth.FREE_SCANS) is the
enforced "Unlimited meal scanning" gate that already ships; the other Pro
features are enforced through require_pro().

Enforcement of the non-scan Pro features is guarded by ENFORCE_PRO so it can be
rolled out without abruptly locking features mid-test. When ENFORCE_PRO is off,
/entitlements still reports the true tier (the client shows the correct Pro
badges + paywall), but require_pro() won't 402 — flip ENFORCE_PRO=1 to turn on
hard server-side blocking.
"""
import os
import logging

from fastapi import APIRouter, HTTPException, Request

import auth

log = logging.getLogger("gofit.entitlements")

router = APIRouter(prefix="/entitlements", tags=["entitlements"])

# Hard server-side blocking of non-scan Pro features. Off by default so a
# rollout doesn't lock features testers are already using; the entitlement
# STATE is always reported truthfully regardless of this flag.
ENFORCE_PRO = os.environ.get("ENFORCE_PRO", "0").strip().lower() in ("1", "true", "yes")

# Feature catalogue. `tier` is the minimum tier that unlocks the feature. Keep
# this list in sync with the client mirror in app/entitlements.ts.
FEATURES = {
    # --- Free ---------------------------------------------------------------
    "food_logging":      {"tier": "free", "label": "Food logging",
                          "desc": "Log meals manually or by describing them."},
    "calorie_tracking":  {"tier": "free", "label": "Calorie tracking",
                          "desc": "Daily calories and macros against your target."},
    "basic_progress":    {"tier": "free", "label": "Basic progress",
                          "desc": "Weight trend and recent history."},
    "water_tracking":    {"tier": "free", "label": "Water tracking", "desc": "Log hydration."},
    "weight_tracking":   {"tier": "free", "label": "Weight tracking", "desc": "Log your weight."},
    "exercise_logging":  {"tier": "free", "label": "Exercise logging",
                          "desc": "Log activity and guided workouts."},
    "barcode":           {"tier": "free", "label": "Barcode lookup",
                          "desc": "Packaged-food nutrition by barcode."},
    # --- Pro ----------------------------------------------------------------
    "unlimited_scan":    {"tier": "pro", "label": "Unlimited meal scanning",
                          "desc": "AI photo/text scans with no daily limit."},
    "ai_recommendations":{"tier": "pro", "label": "AI nutrition recommendations",
                          "desc": "What-to-eat-next tuned to your remaining budget."},
    "meal_planning":     {"tier": "pro", "label": "Personalized meal planning",
                          "desc": "A full day's Indian meal plan for your targets."},
    "advanced_insights": {"tier": "pro", "label": "Advanced insights",
                          "desc": "Deeper trends and adherence analytics."},
    "grocery_lists":     {"tier": "pro", "label": "Grocery lists",
                          "desc": "Auto-built shopping lists from your plan."},
    "adaptive_targets":  {"tier": "pro", "label": "Adaptive nutrition targets",
                          "desc": "Targets that adapt to your progress over time."},
}


def has_feature(is_pro: bool, feature: str) -> bool:
    """True if a (Pro-or-not) account is entitled to `feature`."""
    meta = FEATURES.get(feature)
    if meta is None:
        # Unknown features are treated as free so a typo can't silently paywall
        # something. This is logged so it surfaces in development.
        log.warning("has_feature: unknown feature '%s' -> treated as free", feature)
        return True
    return meta["tier"] == "free" or is_pro


def entitlement_state(account_id: int) -> dict:
    """The account's resolved entitlement state: tier, per-feature access, and
    the scan trial counters (so the client can show 'N free scans left')."""
    usage = auth.usage_for(account_id)
    is_pro = bool(usage["is_pro"])
    used = int(usage["scans_used"])
    limit = int(usage["scans_limit"])
    return {
        "isPro": is_pro,
        "enforced": ENFORCE_PRO,
        "features": {key: has_feature(is_pro, key) for key in FEATURES},
        "catalog": [
            {"key": key, "tier": meta["tier"], "label": meta["label"], "desc": meta["desc"]}
            for key, meta in FEATURES.items()
        ],
        "scans": {
            "used": used,
            "limit": limit,
            "left": None if is_pro else max(0, limit - used),
        },
    }


def require_pro(request: Request, feature: str) -> dict:
    """Raise 402 (paywall) if the signed-in account isn't entitled to `feature`.
    Returns the account on success. Honours ENFORCE_PRO: when off, this only
    resolves the account and never blocks (rollout-safe). Callers pass an
    explicit feature key so the 402 body can name what was gated."""
    acct = auth.require_account(request)
    if not ENFORCE_PRO:
        return acct
    usage = auth.usage_for(acct["id"])
    if not has_feature(bool(usage["is_pro"]), feature):
        meta = FEATURES.get(feature, {"label": feature})
        raise HTTPException(
            status_code=402,
            detail=f"{meta['label']} is a Pro feature. Upgrade to unlock it.",
        )
    return acct


def init_db() -> None:
    """No tables of its own — entitlements derive from accounts.is_pro and the
    scan counters. Present for symmetry with the other modules' init_db()."""
    return None


@router.get("")
def get_entitlements(request: Request):
    acct = auth.require_account(request)
    return entitlement_state(acct["id"])
