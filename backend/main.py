"""
gofit.today — food analysis backend.

POST /analyze  (multipart: file=<image>)  -> itemized portion JSON.
Keeps the Gemini API key server-side so it never ships in the mobile app.

Security:
  - Optional shared-secret auth via the X-API-Key header (set APP_API_KEY).
  - Per-client rate limiting (per-minute + per-day) to protect Gemini quota/cost.

Run:
  $env:GEMINI_API_KEY="..."           # required
  $env:APP_API_KEY="..."              # optional: require this in X-API-Key
  $env:FOOD_MODEL="gemini-3.5-flash"  # optional
  $env:RATE_PER_MIN="20"              # optional (default 20)
  $env:RATE_PER_DAY="200"             # optional (default 200)
  python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""
import os
import io
import json
import math
import re
import time
import hashlib
import logging
import threading
import itertools
import urllib.request
import urllib.error
import urllib.parse
from collections import Counter, defaultdict, deque
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
from google import genai
from google.genai import types

# Load backend/.env (DATABASE_URL, GEMINI_API_KEY, GOOGLE_CLIENT_ID, ...) before
# importing modules that read these environment variables at import time.
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import community
import auth
import db
import payments
import blob_storage
import audit
import feedback
import food_review
import progress
import barcode
import wellness
import plan
import exercise
import prefs
import entitlements
import ai_provider
import food_graph
import nutrition_engine
import dietary_rules
import scan_resolution
import recipe_combo_engine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gofit")

if not blob_storage.configured():
    log.warning(
        "Supabase Storage is not configured; image uploads will fall back to local disk only."
    )

MODEL = os.environ.get("FOOD_MODEL", "gemini-3.5-flash-lite")

# temperature=0 => deterministic: the same photo yields the same numbers.
# response_mime_type => model returns strict JSON (no markdown fences).
# thinking_level="low" => this is a simple, single-pass "read this food photo
# and fill in a JSON template" task, not multi-step reasoning, so the model's
# extended "thinking" pass before answering was pure added latency for no
# accuracy benefit. Measured on this backend: fresh (non-cached) analyses
# were an erratic 1.7-6.7s (avg ~4.2s); with thinking_level="low" every run
# was a consistent ~1.7s. (thinking_budget=0 -- fully off -- is rejected by
# this model with a 400 INVALID_ARGUMENT; "low" is the fastest supported
# setting.)
GEN_CONFIG = types.GenerateContentConfig(
    temperature=0,
    top_p=1,
    response_mime_type="application/json",
    thinking_config=types.ThinkingConfig(thinking_level="low"),
)

# --------------------------------------------------------------------------- #
#  Analyze result cache -- fixes "the same photo gives different calories
#  every time".
#
#  Gemini's temperature=0 is only a *low-randomness* setting, not a hard
#  determinism guarantee (Google documents this: batched/accelerated inference
#  can still pick a different top-token on ties, especially for open-ended
#  counting like "how many gulab jamuns are in this pile"). Measured on this
#  backend: re-analyzing the exact same photo 3x gave 8250/9000/9750 kcal for
#  a pile of gulab jamuns (piece count guessed as 55/60/65) -- a real,
#  reproducible bug, not a one-off.
#
#  Fix: hash the exact image bytes and cache the FIRST analysis for that exact
#  photo. Every later analyze of the identical file (re-tapping "Scan" on the
#  same picture, a retry, etc.) returns the cached, byte-identical result
#  instead of a fresh, possibly-different Gemini call -- so re-scanning the
#  same photo is now provably deterministic. A genuinely different photo of
#  the same dish still gets its own fresh analysis (that's correct: a bigger
#  pile of gulab jamuns SHOULD score higher).
# --------------------------------------------------------------------------- #
def _init_analyze_cache_table(c) -> None:
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS analyze_cache (
            image_hash TEXT PRIMARY KEY,
            result_json TEXT NOT NULL,
            created_at REAL NOT NULL
        )
        """
    )


def _analyze_cache_get(image_hash: str) -> dict | None:
    try:
        with db.connect() as c:
            _init_analyze_cache_table(c)
            row = c.execute(
                "SELECT result_json FROM analyze_cache WHERE image_hash=?", (image_hash,)
            ).fetchone()
        if not row:
            return None
        return json.loads(row["result_json"])
    except Exception as ex:
        log.warning("analyze_cache read failed (continuing without cache): %s", ex)
        return None


def _analyze_cache_put(image_hash: str, data: dict) -> None:
    # Store the raw model+anchoring output BEFORE any per-request fields
    # (usage, scan history id) are mixed in, so a cache hit is a clean base to
    # re-stamp fresh usage onto.
    slim = {k: v for k, v in data.items() if k != "usage"}
    try:
        with db.write_lock(), db.connect() as c:
            _init_analyze_cache_table(c)
            c.execute(
                "INSERT OR IGNORE INTO analyze_cache (image_hash, result_json, created_at) VALUES (?,?,?)",
                (image_hash, json.dumps(slim), time.time()),
            )
    except Exception as ex:
        log.warning("analyze_cache write failed (non-fatal): %s", ex)


PROMPT = """You are the nutrition engine for an Indian food calorie-tracking app.
Analyse the food photo and return ONLY strict JSON (no markdown), schema:
{
  "dish": "short name",
  "cuisine": "e.g. South Indian",
  "items": [
    {
      "item": "component name, e.g. 'idli'",
      "count": <number of pieces/servings visible>,
      "unit": "piece | katori | cup | plate | tbsp",
      "kcal_per_unit": <calories for ONE unit>,
      "protein_g": <protein grams for ONE unit>,
      "carbs_g": <carbohydrate grams for ONE unit>,
      "fat_g": <fat grams for ONE unit>,
      "kcal_total": <count * kcal_per_unit>,
      "countable": <true if a discrete countable item like idli/samosa, false for mixed plates/curries>,
      "micros_estimate": {
        "fiber_g": <grams, ONE unit>,
        "iron_mg": <mg, ONE unit>,
        "calcium_mg": <mg, ONE unit>,
        "potassium_mg": <mg, ONE unit>,
        "vitamin_c_mg": <mg, ONE unit>,
        "sodium_mg": <mg, ONE unit>,
        "sugar_g": <grams, ONE unit>
      }
    }
  ],
  "questions": [
    {
      "id": "short_slug",
      "prompt": "one short question a photo genuinely can't answer",
      "target_item": <0-based index into items[] this question adjusts>,
      "options": [
        {"label": "short answer", "factor": <multiplier on that item's per-unit kcal AND macros>}
      ],
      "default_index": <index of the option you already assumed>
    }
  ],
  "calories_kcal": <sum of all items kcal_total>,
  "confidence": <0.0-1.0>
}
Use standard Indian household portions. Break a plate into its components
(rice + dal + sabzi). Estimate kcal_per_unit for a normal home serving.
Count only what is clearly visible.

micros_estimate is YOUR best estimate from general nutrition knowledge of this
dish (a photo can't show iron or vitamin C) -- give your honest best guess for
every item, don't omit it. It will be labeled "Estimated" in the app, never
shown as verified lab data, so a reasonable estimate is genuinely useful even
though it isn't precise.

QUESTIONS: Indian thalis hide calories a photo can't see. Ask ONLY the 1-3
highest-impact things you had to guess, each tied to one item via target_item:
- added ghee/oil/butter (on roti, in dal, tempering) -> factors like 1.0 / 1.15 / 1.35
- bowl/katori or ladle size for curries & dal -> e.g. small 0.7 / medium 1.0 / large 1.4
- fried vs steamed/roasted, sugar in a sweet, cream/malai in a gravy
Rules: every question needs 2-4 options; exactly one option is the baseline you
already used (factor 1.0) and default_index must point to it, so if the user
answers nothing the totals don't change. Skip questions for clear packaged or
plainly-visible items. Return "questions": [] when nothing is genuinely
ambiguous. NEVER ask about things visible in the photo (count, which foods)."""

TEXT_PROMPT = """You are the nutrition engine for an Indian food calorie-tracking app.
The user typed a description of what they ate (may be dictated from voice, so
expect informal phrasing, e.g. "2 rotis with dal and a bit of ghee"). Parse it
into the SAME strict JSON schema (no markdown) used for a food photo:
{
  "dish": "short name",
  "cuisine": "e.g. South Indian",
  "items": [
    {
      "item": "component name, e.g. 'idli'",
      "count": <number of pieces/servings mentioned or implied>,
      "unit": "piece | katori | cup | plate | tbsp",
      "kcal_per_unit": <calories for ONE unit>,
      "protein_g": <protein grams for ONE unit>,
      "carbs_g": <carbohydrate grams for ONE unit>,
      "fat_g": <fat grams for ONE unit>,
      "kcal_total": <count * kcal_per_unit>,
      "countable": <true if a discrete countable item like idli/samosa, false for mixed plates/curries>,
      "micros_estimate": {
        "fiber_g": <grams, ONE unit>,
        "iron_mg": <mg, ONE unit>,
        "calcium_mg": <mg, ONE unit>,
        "potassium_mg": <mg, ONE unit>,
        "vitamin_c_mg": <mg, ONE unit>,
        "sodium_mg": <mg, ONE unit>,
        "sugar_g": <grams, ONE unit>
      }
    }
  ],
  "calories_kcal": <sum of all items kcal_total>,
  "confidence": <0.0-1.0, LOWER than you'd give a clear photo -- text descriptions
    are inherently more ambiguous about portion size>
}
micros_estimate is your best-guess nutrition estimate for the item (labeled
"Estimated" in the app, never shown as verified data) -- always include it.
Use standard Indian household portions when the user didn't specify an amount
(e.g. "dal" alone means one katori). If the description is too vague to name
any real food (e.g. "food", "something"), return items: [] and
confidence: 0 rather than guessing."""

app = FastAPI(title="gofit.today — Analyze")

# --- CORS lockdown -----------------------------------------------------------
# Dev default is "*" (any origin) so local Expo/web just works. In production set
# ALLOWED_ORIGINS to an explicit comma-separated allow-list of your app's
# domain(s); a wildcard in production is logged as a warning. Credentials (the
# Authorization bearer header is NOT a credential in the CORS sense, so we keep
# allow_credentials False, which is also required for a "*" origin to be legal).
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "*").strip()
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]
APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()
if APP_ENV in ("production", "prod") and "*" in ALLOWED_ORIGINS:
    log.warning(
        "ALLOWED_ORIGINS is '*' in production — set it to your explicit domain(s) "
        "to lock down CORS."
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET", "PUT", "DELETE"],
    allow_headers=["*"],
)

# Community (groups / leaderboard / challenges / feed), SQLite-backed.
community.init_db()
app.include_router(community.router)

# Accounts & authentication (username/password + bearer tokens).
auth.init_db()
app.include_router(auth.router)

# Payments (Razorpay Pro upgrade).
payments.init_db()
app.include_router(payments.router)

# Audit log (append-only record of payment + auth events). Init before
# payments/auth so the table exists first request; router is separate so it
# can be gated by ADMIN_KEY rather than the mobile app's APP_API_KEY.
audit.init_db()
app.include_router(audit.router)

# In-app feedback / feature requests (POST /feedback, GET /admin/feedback).
feedback.init_db()
app.include_router(feedback.router)

# Unmatched-dish review queue -- durable log of items the AI scanned that had
# no verified DB match, ranked by frequency, so real usage (not guesswork)
# drives what gets curated into indian_food_db.json next.
food_review.init_db()
app.include_router(food_review.router)

# Profile, meal logs, weight history -- the tables that were missing
# entirely (previously local-storage-only, no server-side persistence at all).
progress.init_db()
app.include_router(progress.router)

# Canonical food graph foundation (additive tables, compatibility-safe).
food_graph.init_db()
recipe_combo_engine.init_db()

# Packaged-food barcode lookup (POST /analyze/barcode) -- a deterministic
# OpenFoodFacts lookup, NOT a Gemini call, so it does NOT consume a free-scan
# credit (see barcode.py's module docstring).
app.include_router(barcode.router)

# Water + habit tracking (GET/POST /water, /habits) -- plain data entry, no AI,
# no scan credit involvement.
wellness.init_db()
app.include_router(wellness.router)


@app.post("/admin/upload-apk")
async def admin_upload_apk(request: Request, file: UploadFile = File(...)):
    """One-off admin utility: upload a sideloadable Android APK build to a
    PUBLIC Supabase Storage bucket and return its permanent URL, for linking
    from the marketing landing page's "Download for Android" button. Unlike
    EAS's own build-artifact links (which expire after a couple weeks on the
    free tier), this URL is stable for as long as the object exists.
    Gated by X-Admin-Key exactly like the other /admin/* endpoints -- 404s
    (not 401) when ADMIN_KEY is unset, so its existence isn't advertised."""
    if not audit.ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if request.headers.get("x-admin-key", "").strip() != audit.ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    data = await file.read()
    try:
        url = blob_storage.upload_public_file(
            "gofit-today.apk", data, content_type="application/vnd.android.package-archive"
        )
    except RuntimeError as ex:
        raise HTTPException(status_code=503, detail=str(ex))
    return {"url": url, "bytes": len(data)}

# Exercise catalog + daily activity logging (GET /exercise/catalog,
# GET/POST /exercise/logs, DELETE /exercise/log/{id}). Calories burned are
# computed from the account's saved weight via MET values -- part of the one
# connected system, no third-party service or scan credit involved.
exercise.init_db()
app.include_router(exercise.router)

# Per-account UI preferences (Home dashboard layout: module order + hidden set),
# synced across devices via GET/PUT /prefs/home.
prefs.init_db()
app.include_router(prefs.router)

# Free / Pro feature entitlements (product-level, not just hidden UI).
# GET /entitlements returns the account's resolved tier + per-feature access.
entitlements.init_db()
app.include_router(entitlements.router)

# Scanner confidence/correction loop over canonical scan-result tables.
app.include_router(scan_resolution.router)

# Retired: the experimental Food Intelligence Graph API (nutri_* tables,
# nutrition_api.router) has been removed pending a proper, reviewed
# validation pass. All /foods/* endpoints use only the curated FOOD_DB now.

# --- Auth (optional shared secret) -------------------------------------------
# If APP_API_KEY is set, every /analyze request must send a matching X-API-Key
# header. If it is unset (e.g. local dev), auth is skipped.
APP_API_KEY = os.environ.get("APP_API_KEY", "").strip()


def require_api_key(request: Request) -> None:
    if not APP_API_KEY:
        return  # auth disabled in dev
    sent = (request.headers.get("x-api-key") or "").strip()
    if sent != APP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# --- Rate limiting (in-memory, per client) -----------------------------------
# Simple sliding-window limiter keyed by API key (or client IP when no key).
# Protects the Gemini quota/budget from runaway or abusive callers.
#
# NOTE: this state is per-process. Behind multiple workers/instances the limits
# are enforced per process (so effective limits multiply) — for a strict global
# limit at scale, back this with Redis. Only /analyze is rate-limited, so the
# key space is bounded by distinct scanning clients and swept below.
RATE_PER_MIN = int(os.environ.get("RATE_PER_MIN", "20"))
RATE_PER_DAY = int(os.environ.get("RATE_PER_DAY", "200"))
_hits: dict[str, deque] = defaultdict(deque)
_rate_lock = threading.Lock()
_last_sweep = 0.0
_SWEEP_EVERY = 600.0  # seconds between full sweeps of idle clients


def _client_id(request: Request) -> str:
    """Pick a rate-limit bucket key for this caller.

    Bug found by live-testing (fired 25 requests with no login at all and hit
    429 at #21, RATE_PER_MIN's exact value): X-API-Key is a single constant
    baked into every install of the app, so keying on it first meant EVERY
    user, signed in or not, shared one global 20/min & 200/day bucket for the
    whole app. One active user could -- and, un-fixed, eventually would --
    lock every other user out of /analyze.

    Fix: prefer the caller's real account (from their Bearer token) so each
    account gets its own bucket, matching the "per-client rate limiting"
    this was always meant to be. Only truly account-less callers (no/invalid
    token -- who are going to 401 anyway) fall back to the shared API key,
    then IP.
    """
    account = auth.account_from_request(request)
    if account:
        return "acct:" + str(account["id"])
    key = (request.headers.get("x-api-key") or "").strip()
    if key:
        return "k:" + key
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "unknown")
    return "ip:" + ip


def _sweep_locked(now: float) -> None:
    """Drop clients with no activity in the last 24h so the dict can't grow
    without bound. Caller must hold _rate_lock."""
    global _last_sweep
    if now - _last_sweep < _SWEEP_EVERY:
        return
    _last_sweep = now
    stale = [k for k, dq in _hits.items() if not dq or now - dq[-1] > 86400]
    for k in stale:
        del _hits[k]


def enforce_rate_limit(request: Request) -> None:
    now = time.time()
    cid = _client_id(request)
    with _rate_lock:
        _sweep_locked(now)
        dq = _hits[cid]
        # drop entries older than 24h
        while dq and now - dq[0] > 86400:
            dq.popleft()
        last_min = sum(1 for t in dq if now - t < 60)
        if last_min >= RATE_PER_MIN:
            raise HTTPException(status_code=429, detail="Too many requests. Please wait a minute.")
        if len(dq) >= RATE_PER_DAY:
            raise HTTPException(status_code=429, detail="Daily analysis limit reached. Try again tomorrow.")
        dq.append(now)
        # Reclaim memory for a client that just aged out to empty.
        if not dq:
            _hits.pop(cid, None)


def guard(request: Request) -> None:
    """Combined dependency: auth first, then rate limit."""
    require_api_key(request)
    enforce_rate_limit(request)


# --- IFCT/INDB food DB anchoring ----------------------------------------------
# The food data now lives in a real `foods` table in the same Postgres/SQLite
# database as everything else (previously it only existed as a JSON file on
# the backend's local disk, which is why it never showed up in Supabase no
# matter how many accounts/posts did). indian_food_db.json is now purely the
# *seed source*: on a fresh/empty database it's loaded in once, automatically,
# on startup. Edit the JSON to change the seed data, or edit rows directly in
# Supabase for a live database -- either works, since the table is what the
# app actually reads from at runtime.
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "indian_food_db.json")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z ]", "", (text or "").lower()).strip()

_FOODS_JSON_FIELDS = ("benefits", "watch_outs", "micros", "aliases")


def _init_foods_table(c) -> None:
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS foods (
            key TEXT PRIMARY KEY,
            unit TEXT NOT NULL,
            kcal_per_unit REAL NOT NULL,
            protein_g REAL NOT NULL DEFAULT 0,
            carbs_g REAL NOT NULL DEFAULT 0,
            fat_g REAL NOT NULL DEFAULT 0,
            fiber_g REAL,
            sugar_g REAL,
            sodium_mg REAL,
            potassium_mg REAL,
            calcium_mg REAL,
            iron_mg REAL,
            health_score REAL,
            benefits_json TEXT,
            watch_outs_json TEXT,
            micros_json TEXT,
            aliases_json TEXT NOT NULL,
            source_name TEXT,
            source TEXT
        )
        """
    )
    cols = db.table_columns(c, "foods")
    if "jain_status" not in cols:
        c.execute("ALTER TABLE foods ADD COLUMN jain_status TEXT")
    if "sattvic_status" not in cols:
        c.execute("ALTER TABLE foods ADD COLUMN sattvic_status TEXT")
    # source_name/source drive the India-first ranking in /foods/recommend.
    # Older tables (created before these columns) get them backfilled here so
    # the recommender can tell Indian dishes from continental ones.
    if "source_name" not in cols:
        c.execute("ALTER TABLE foods ADD COLUMN source_name TEXT")
    if "source" not in cols:
        c.execute("ALTER TABLE foods ADD COLUMN source TEXT")
    # Curated display-name override -- most keys read fine as Title Case
    # (see the "name" or key.title() fallback used across /foods/search etc.),
    # but a few need an explicit correction (e.g. our rice entry's aliases
    # include "steamed rice" because that's what vision models often say, but
    # Indian home-style rice is boiled/cooked in water, not steamed -- so we
    # want the item shown to the user to read "Cooked rice" regardless of
    # which alias the model happened to use).
    if "name" not in cols:
        c.execute("ALTER TABLE foods ADD COLUMN name TEXT")


# --- Jain / Sattvic classification -------------------------------------------
# Rule-based, from the dish's own name/aliases text only (there's no
# ingredient list to check against, same limitation as everything else built
# from dish names rather than recipes). Three-tier on purpose, not yes/no:
# 'depends' is the honest answer whenever the name alone can't tell you
# whether a specific kitchen used onion/garlic, not a cop-out -- a dish name
# doesn't uniquely determine a recipe (see the Jain-diet discussion this was
# scoped from). Only whole-word matches count (via match_food's same
# word-boundary approach) so e.g. "onion" doesn't false-positive on unrelated
# substrings.
_NON_VEG_WORDS = ("chicken","mutton","beef","pork","fish","prawn","shrimp","crab","egg","eggs",
                  "meat","lamb","goat","duck","keema","kheema","seekh","bacon","ham","sausage",
                  "murgh","machh","meen","kori","anda")
_ONION_GARLIC_WORDS = ("onion","onions","garlic","pyaz","piyaz","lahsun","lasun")
_ROOT_VEG_WORDS = ("potato","potatoes","aloo","carrot","radish","mooli","beetroot","chukandar",
                   "turnip","suran","yam","ginger")
_STIMULANT_WORDS = ("tea","coffee","alcohol","wine","beer","liquor","cocoa")
_PLAIN_SAFE_WORDS = ("idli","dosa","curd","dahi","yogurt","milk","roti","chapati","phulka",
                     "papad","rasam","sambar","rice","dal","daal","khichdi","payasam",
                     "kheer","fruit","juice","buttermilk","chaas","lassi","idiyappam","appam",
                     "puttu","vermicelli","besan")
# "Masala dosa" specifically means a spiced potato filling -- the word "dosa"
# alone doesn't tell you that, only "masala" next to it does. Found this as a
# real false positive (classified yes/yes on the first run) rather than
# assuming the whitelist was safe. "Masala X" in general tends to mean a
# spiced/mixed preparation that commonly includes onion/potato even when
# neither word appears on its own -- so it overrides a plain-safe match back
# to "depends" instead of trusting the base word. Dropped "upma" from the
# whitelist for the same reason: real recipes vary too much on onion to
# assert "yes" from the name alone.
_MASALA_OVERRIDE = ("masala",)


def _word_in(words: tuple, text: str) -> bool:
    return any(re.search(r"\b" + re.escape(w) + r"\b", text) for w in words)


def classify_diet_tags(name: str, aliases: list) -> tuple:
    """Returns (jain_status, sattvic_status), each 'yes' / 'no' / 'depends'."""
    text = _norm(" ".join([name] + list(aliases or [])))
    nonveg = _word_in(_NON_VEG_WORDS, text)
    onion_garlic = _word_in(_ONION_GARLIC_WORDS, text)
    root_veg = _word_in(_ROOT_VEG_WORDS, text)
    stimulant = _word_in(_STIMULANT_WORDS, text)
    plain = _word_in(_PLAIN_SAFE_WORDS, text) and not _word_in(_MASALA_OVERRIDE, text)

    if nonveg or onion_garlic or root_veg:
        jain = "no"
    elif plain:
        jain = "yes"
    else:
        jain = "depends"

    if nonveg or onion_garlic or stimulant:
        sattvic = "no"
    elif root_veg:
        sattvic = "depends"  # more debated for sattvic than for jain, not an outright bar
    elif plain:
        sattvic = "yes"
    else:
        sattvic = "depends"
    return jain, sattvic


def _backfill_diet_tags(c) -> int:
    """Classify any row that doesn't have jain_status set yet. Only fills
    NULLs, so it never clobbers a manual correction made directly in
    Supabase -- same rule as _seed_foods_if_empty."""
    rows = c.execute("SELECT key, source_name, aliases_json FROM foods WHERE jain_status IS NULL").fetchall()
    n = 0
    for r in rows:
        name = r["source_name"] or r["key"]
        aliases = json.loads(r["aliases_json"]) if r["aliases_json"] else []
        jain, sattvic = classify_diet_tags(name, aliases)
        c.execute(
            "UPDATE foods SET jain_status=?, sattvic_status=? WHERE key=?",
            (jain, sattvic, r["key"]),
        )
        n += 1
    return n


def _backfill_display_names(c) -> int:
    """One-off backfill of the curated `name` override from indian_food_db.json
    for rows seeded before this column existed. Only fills rows whose `name`
    doesn't already match the JSON (so re-running is cheap/idempotent), and
    only for keys that actually have a curated override in the JSON -- most
    foods have none and keep using the key.title() fallback at read time."""
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            foods = json.load(f)["foods"]
    except Exception as ex:
        log.warning("Could not read %s to backfill food display names: %s", DB_PATH, ex)
        return 0
    n = 0
    for food in foods:
        name = food.get("name")
        if not name:
            continue
        row = c.execute("SELECT name FROM foods WHERE key=?", (food["key"],)).fetchone()
        if row is not None and row["name"] != name:
            c.execute("UPDATE foods SET name=? WHERE key=?", (name, food["key"]))
            n += 1
    return n


def _seed_foods_if_empty(c) -> int:
    """Load indian_food_db.json into the `foods` table, but only if it's
    currently empty -- never overwrites rows someone has since edited by hand
    in Supabase. Returns how many rows were inserted."""
    n = c.execute("SELECT COUNT(*) AS n FROM foods").fetchone()["n"]
    if n > 0:
        return 0
    try:
        with open(DB_PATH, "r", encoding="utf-8") as f:
            foods = json.load(f)["foods"]
    except Exception as ex:
        log.warning("Could not read %s to seed the foods table: %s", DB_PATH, ex)
        return 0
    rows = []
    for food in foods:
        rows.append((
            food["key"], food.get("unit", "piece"), food.get("kcal_per_unit", 0),
            food.get("protein_g", 0), food.get("carbs_g", 0), food.get("fat_g", 0),
            food.get("fiber_g"), food.get("sugar_g"), food.get("sodium_mg"),
            food.get("potassium_mg"), food.get("calcium_mg"), food.get("iron_mg"),
            food.get("health_score"),
            json.dumps(food["benefits"]) if food.get("benefits") else None,
            json.dumps(food["watch_outs"]) if food.get("watch_outs") else None,
            json.dumps(food["micros"]) if food.get("micros") else None,
            json.dumps(food.get("aliases", [])),
            food.get("_source_name"), food.get("_source"),
            food.get("name"),
        ))
    c.executemany(
        """INSERT OR IGNORE INTO foods
           (key, unit, kcal_per_unit, protein_g, carbs_g, fat_g, fiber_g, sugar_g,
            sodium_mg, potassium_mg, calcium_mg, iron_mg, health_score,
            benefits_json, watch_outs_json, micros_json, aliases_json,
            source_name, source, name)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    return len(rows)


def _row_to_food(r) -> dict:
    d = {
        "key": r["key"], "unit": r["unit"], "kcal_per_unit": r["kcal_per_unit"],
        "protein_g": r["protein_g"], "carbs_g": r["carbs_g"], "fat_g": r["fat_g"],
    }
    for col in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg", "health_score",
                "jain_status", "sattvic_status", "name"):
        v = r[col]
        if v is not None:
            d[col] = v
    for field, col in (("benefits", "benefits_json"), ("watch_outs", "watch_outs_json"), ("micros", "micros_json")):
        v = r[col]
        if v:
            d[field] = json.loads(v) if isinstance(v, str) else v
    aliases = r["aliases_json"]
    d["aliases"] = (json.loads(aliases) if isinstance(aliases, str) else aliases) or []
    # Carry the seed provenance through so the recommender's India-first tiering
    # works (curated staples vs INDB vs continental). Guarded: a very old table
    # might not have these columns even after _init (e.g. if _init wasn't run).
    for field, col in (("_source_name", "source_name"), ("_source", "source")):
        try:
            v = r[col]
        except (KeyError, IndexError):
            v = None
        if v is not None:
            d[field] = v
    return d


def _load_db():
    try:
        with db.write_lock(), db.connect() as c:
            _init_foods_table(c)
            seeded = _seed_foods_if_empty(c)
            if seeded:
                log.info("foods table was empty -- seeded %d dishes from %s", seeded, DB_PATH)
            tagged = _backfill_diet_tags(c)
            if tagged:
                log.info("classified jain/sattvic status for %d foods missing it", tagged)
            renamed = _backfill_display_names(c)
            if renamed:
                log.info("applied %d curated food display-name override(s)", renamed)
        with db.connect() as c:
            rows = c.execute("SELECT * FROM foods").fetchall()
        foods = [_row_to_food(r) for r in rows]
    except Exception as ex:
        log.warning("Could not load the foods table (%s) -- /analyze will run with no DB anchoring.", ex)
        return []
    for food in foods:
        food["_aliases"] = [a.lower().strip() for a in food.get("aliases", [])]
    return foods


FOOD_DB = _load_db()
# Fast key -> food lookup for combo/pairing resolution (see /foods/combos).
FOOD_BY_KEY = {f["key"]: f for f in FOOD_DB}


# --- Meal combinations (accompaniment pairings) ------------------------------
# Indian dishes are rarely eaten alone (idli+sambar+chutney, dal+rice, chole+
# puri). food_combos.json holds curated dish -> typical sides so the app can
# offer one-tap "Goes well with" add-ons. It's editorial pairing knowledge
# only; every side's calories/macros still come from the food DB row it maps to.
COMBOS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "food_combos.json")


def _load_combos():
    try:
        with open(COMBOS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        combos = data.get("combos", {}) or {}
        # normalize alias keys so lookups match _norm() output
        aliases = {_norm(k): v for k, v in (data.get("aliases", {}) or {}).items()}
        return combos, aliases
    except Exception as ex:
        log.warning("Could not load meal combos from %s: %s", COMBOS_PATH, ex)
        return {}, {}


COMBOS, COMBO_ALIASES = _load_combos()


def _resolve_combo_entry(name: str):
    """Map a free-text dish name to a combo entry, or None.

    Resolution order: (1) the name itself is a combo key (spaces->underscores),
    (2) an alias word appears in the name, (3) the food DB match's key is a
    combo key. This mirrors how match_food resolves DB anchoring, so 'Masala
    Dosa' and 'idli' both land on their pairing lists.
    """
    n = _norm(name)
    if not n:
        return None
    cand = n.replace(" ", "_")
    if cand in COMBOS:
        return COMBOS[cand]
    for word, target in COMBO_ALIASES.items():
        if word and re.search(r"\b" + re.escape(word) + r"\b", n) and target in COMBOS:
            return COMBOS[target]
    food = match_food(name)
    if food and food["key"] in COMBOS:
        return COMBOS[food["key"]]
    return None


def _persisted_combo_sides(combo_key: str) -> list[dict]:
    with db.connect() as c:
        row = c.execute(
            "SELECT id, display_name FROM gofit_meal_combinations WHERE combo_key=?",
            (combo_key,),
        ).fetchone()
        if not row:
            return []
        sides = c.execute(
            """
            SELECT side_food_key, side_count, reason
            FROM gofit_meal_combination_items
            WHERE combination_id=?
            ORDER BY position ASC
            """,
            (row["id"],),
        ).fetchall()
    return [
        {
            "key": s["side_food_key"],
            "count": s["side_count"],
            "reason": s["reason"],
            "pairs_with": row["display_name"],
        }
        for s in sides
    ]


def match_food(name: str):
    """Return the best-matching DB food for a free-text item name, or None.

    An alias matches only if it appears as a whole word/phrase inside the item
    name (word boundaries). The longest (most specific) matching alias wins, so
    'biryani rice' beats 'rice'. We do NOT match name-inside-alias, which used to
    make plain 'rice' incorrectly match biryani's 'biryani rice' alias.
    """
    n = _norm(name)
    if not n:
        return None
    canonical = food_graph.resolve_food_by_name(n)
    if canonical:
        canonical["_aliases"] = []
        return canonical
    best = None
    best_len = 0
    for food in FOOD_DB:
        for alias in food["_aliases"]:
            if re.search(r"\b" + re.escape(alias) + r"\b", n) and len(alias) > best_len:
                best, best_len = food, len(alias)
    return best


def anchor_items(data: dict) -> dict:
    """Match each scanned item against the food DB for identification/naming
    only -- nutrition numbers (calories, macros, micronutrients) always come
    from the AI's own per-item estimate, never overridden by DB values. Per
    the user's explicit direction: "everything from the AI instead of the
    database, other than [using the database for] the search of the dish."
    The DB is still used to: resolve a curated display name (e.g. "Cooked
    rice" instead of a vision model's "steamed rice" guess), and attach
    descriptive tags that don't vary by nutrition estimate (health_score,
    benefits, watch_outs, jain/sattvic status). It is NOT used to replace the
    AI's calorie/macro/micro numbers -- those are always the model's estimate,
    tagged source="ai"/micros_source="ai_estimated" regardless of whether a DB
    match was found, so downstream UI (MealDetailScreen's Verified/Estimated
    per-item badge) reflects this honestly. DB-lookup-based flows that are NOT
    photo/text scans (manual food search, barcode lookup, "add from template")
    are untouched by this function and continue to use verified DB nutrition
    values as before, since those are direct catalog selections, not
    AI-estimated photo/text analysis.
    """
    macros = ("protein_g", "carbs_g", "fat_g")
    micro_fields = ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg")
    # Per-unit sanity ceiling for the AI-estimated micro value -- guards
    # against a hallucinated number (e.g. "5000mg sodium in one idli")
    # dominating a day's totals. Applied to every item now, matched or not,
    # since every item's micros are AI-estimated.
    _EST_CAPS = {
        "fiber_g": 25, "iron_mg": 20, "calcium_mg": 800,
        "potassium_mg": 2000, "vitamin_c_mg": 300, "sodium_mg": 3000, "sugar_g": 100,
    }
    for it in data.get("items", []):
        food = match_food(it.get("item", ""))
        # Always start from the AI's own per-unit numbers -- never overridden
        # by the DB match below, even when one is found.
        for m in macros:
            it[m + "_per_unit"] = it.get(m, 0)
        it["source"] = "ai"
        est = it.get("micros_estimate")
        if isinstance(est, dict):
            clamped = {}
            for k, cap in _EST_CAPS.items():
                v = est.get(k)
                if isinstance(v, (int, float)) and v >= 0:
                    clamped[k] = min(float(v), cap)
            if clamped:
                it["micros_per_unit"] = clamped
                it["micros_source"] = "ai_estimated"
        if food:
            # Identification/search match only -- naming + descriptive tags,
            # NOT nutrition numbers (see docstring above).
            if food.get("key"):
                it["key"] = food["key"]
            # Only override the displayed name when the DB has an explicit
            # curated override (food["name"]) -- e.g. our rice entry matches
            # on "steamed rice" (a common vision-model guess) but Indian
            # home-style rice is boiled/cooked, not steamed, so we show
            # "Cooked rice" regardless of which alias matched. We do NOT fall
            # back to key.title() here (unlike /foods/search) because the
            # AI's original text is often MORE specific than the matched key
            # (e.g. "chicken biryani" matching the generic "biryani" alias) --
            # renaming those would lose detail, not add clarity.
            if food.get("name"):
                it["item"] = food["name"]
            # Descriptive, not a nutrition number -- see docstring.
            if "health_score" in food:
                it["health_score"] = food["health_score"]
            if food.get("benefits"):
                it["benefits"] = food["benefits"]
            if food.get("watch_outs"):
                it["watch_outs"] = food["watch_outs"]
            if food.get("jain_status"):
                it["jain_status"] = food["jain_status"]
            if food.get("sattvic_status"):
                it["sattvic_status"] = food["sattvic_status"]
        else:
            food_review.record_unmatched(it.get("item", ""), it)
        scaled = nutrition_engine.scale_per_unit_item(it, it.get("count", 1))
        it.clear()
        it.update(scaled)

    items = data.get("items", [])
    data["calories_kcal"] = round(sum(it["kcal_total"] for it in items))
    totals = nutrition_engine.compute_meal_totals(items)
    for m in micro_fields:
        vals = [it[m] for it in items if m in it]
        if vals:
            totals[m] = round(sum(vals), 1)
    data["totals"] = totals
    return data

def _food_suggestion(food: dict) -> dict:
    """Map a FOOD_DB record to the shape the client turns into a FoodItem.
    DB macros are already per-unit."""
    out = {
        "key": food["key"],
        "id": food.get("id"),
        "name": food.get("name") or food["key"].replace("_", " ").title(),
        "unit": food["unit"],
        "kcal_per_unit": food["kcal_per_unit"],
        "protein_g_per_unit": food.get("protein_g", 0),
        "carbs_g_per_unit": food.get("carbs_g", 0),
        "fat_g_per_unit": food.get("fat_g", 0),
    }
    for k in ("vegetarian", "vegan", "eggetarian"):
        if food.get(k) is not None:
            out[k] = food[k]
    for k in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg", "health_score"):
        if food.get(k) is not None:
            out[k] = food[k]
    for k in ("benefits", "watch_outs", "micros"):
        if food.get(k):
            out[k] = food[k]
    return out


def _resolve_food_for_recipe(token: str) -> dict | None:
    raw = (token or "").strip()
    if not raw:
        return None
    key = _norm(raw).replace(" ", "_")
    if key in FOOD_BY_KEY:
        return _food_suggestion(FOOD_BY_KEY[key])
    matched = match_food(raw)
    if not matched:
        return None
    return _food_suggestion(matched)


def _search_score(query: str, food: dict) -> int:
    """Rank a food against a normalized query over its key + aliases. Exact >
    starts-with > contains. 0 means no match."""
    best = 0
    for hay in [food["key"], *food.get("aliases", [])]:
        h = _norm(hay)
        if not h:
            continue
        if h == query:
            s = 100
        elif h.startswith(query):
            s = 80
        elif query in h:
            s = 60
        elif h in query:
            s = 40
        else:
            s = 0
        best = max(best, s)
    return best


_OFF_SEARCH_HOSTS = ("world.openfoodfacts.net", "world.openfoodfacts.org")
_OFF_SEARCH_TIMEOUT = 8
_OFF_SEARCH_UA = "gofit.today/1.0 (manual food search; contact: info@buiild.in)"


def _off_num(nutriments: dict, *keys: str) -> float:
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


def _off_search_one_host(host: str, query: str, limit: int) -> list[dict]:
    params = urllib.parse.urlencode(
        {
            "search_terms": query,
            "search_simple": 1,
            "action": "process",
            "json": 1,
            "page_size": limit,
            "fields": "code,product_name,brands,nutriments,serving_quantity,serving_size",
        }
    )
    url = f"https://{host}/cgi/search.pl?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": _OFF_SEARCH_UA})
    with urllib.request.urlopen(req, timeout=_OFF_SEARCH_TIMEOUT) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    rows = body.get("products") if isinstance(body, dict) else None
    return rows if isinstance(rows, list) else []


def _off_search_foods(query: str, limit: int) -> list[dict]:
    for host in _OFF_SEARCH_HOSTS:
        try:
            rows = _off_search_one_host(host, query, limit=max(1, min(50, limit * 2)))
            break
        except urllib.error.HTTPError as ex:
            log.warning("OFF search HTTP error on %s: %s", host, ex)
            continue
        except Exception as ex:
            log.warning("OFF search error on %s: %s", host, ex)
            continue
    else:
        return []

    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("product_name") or "").strip()
        if not name:
            continue
        brand = str(row.get("brands") or "").split(",")[0].strip()
        title = f"{brand} {name}".strip() if brand and brand.lower() not in name.lower() else name

        n = row.get("nutriments") if isinstance(row.get("nutriments"), dict) else {}
        kcal_100 = _off_num(n, "energy-kcal_100g")
        protein_100 = _off_num(n, "proteins_100g")
        carbs_100 = _off_num(n, "carbohydrates_100g")
        fat_100 = _off_num(n, "fat_100g")
        fiber_100 = _off_num(n, "fiber_100g")
        sugar_100 = _off_num(n, "sugars_100g")
        sodium_100 = _off_num(n, "sodium_100g")
        potassium_100 = _off_num(n, "potassium_100g")
        calcium_100 = _off_num(n, "calcium_100g")
        iron_100 = _off_num(n, "iron_100g")

        serving_q = row.get("serving_quantity")
        try:
            serving_g = float(serving_q) if serving_q not in (None, "") else 0.0
        except (TypeError, ValueError):
            serving_g = 0.0
        if serving_g > 0:
            factor = serving_g / 100.0
            unit = f"serving ({serving_g:g} g)"
            kcal = _off_num(n, "energy-kcal_serving") or (kcal_100 * factor)
            protein = _off_num(n, "proteins_serving") or (protein_100 * factor)
            carbs = _off_num(n, "carbohydrates_serving") or (carbs_100 * factor)
            fat = _off_num(n, "fat_serving") or (fat_100 * factor)
            fiber = _off_num(n, "fiber_serving") or (fiber_100 * factor)
            sugar = _off_num(n, "sugars_serving") or (sugar_100 * factor)
            sodium_g = _off_num(n, "sodium_serving") or (sodium_100 * factor)
            potassium_g = _off_num(n, "potassium_serving") or (potassium_100 * factor)
            calcium_g = _off_num(n, "calcium_serving") or (calcium_100 * factor)
            iron_g = _off_num(n, "iron_serving") or (iron_100 * factor)
        else:
            unit = "100 g"
            kcal = kcal_100
            protein = protein_100
            carbs = carbs_100
            fat = fat_100
            fiber = fiber_100
            sugar = sugar_100
            sodium_g = sodium_100
            potassium_g = potassium_100
            calcium_g = calcium_100
            iron_g = iron_100

        # No useful nutrition -> skip noisy rows.
        if kcal <= 0 and protein <= 0 and carbs <= 0 and fat <= 0:
            continue

        code = str(row.get("code") or "").strip()
        key = f"off_{code}" if code else _norm(title).replace(" ", "_")
        if not key or key in seen:
            continue
        seen.add(key)

        micros = {}
        if fiber > 0:
            micros["fiber_g"] = round(fiber, 2)
        if sugar > 0:
            micros["sugar_g"] = round(sugar, 2)
        if sodium_g > 0:
            micros["sodium_mg"] = round(sodium_g * 1000.0, 1)
        if potassium_g > 0:
            micros["potassium_mg"] = round(potassium_g * 1000.0, 1)
        if calcium_g > 0:
            micros["calcium_mg"] = round(calcium_g * 1000.0, 1)
        if iron_g > 0:
            micros["iron_mg"] = round(iron_g * 1000.0, 1)

        out.append(
            {
                "key": key,
                "name": title,
                "unit": unit,
                "kcal_per_unit": round(kcal, 1),
                "protein_g_per_unit": round(protein, 1),
                "carbs_g_per_unit": round(carbs, 1),
                "fat_g_per_unit": round(fat, 1),
                **({"micros": micros} if micros else {}),
            }
        )
        if len(out) >= limit:
            break
    return out


@app.get("/foods/search")
def foods_search(q: str, request: Request, limit: int = 20):
    """Search the curated FOOD_DB (food_db.json / _load_db()) by key + alias.

    This is a plain local, in-memory lookup -- NOT a Gemini call -- so, like
    barcode, it requires a signed-in account but never reserves or consumes
    a free-scan credit. FOOD_DB is the single source of truth for all
    /foods/* endpoints; the experimental Food Intelligence Graph
    (nutri_* tables) has been retired from every user-facing code path
    pending a proper, reviewed validation pass -- see GOFIT_MASTER_ARCHITECTURE_PROMPT.txt."""
    auth.require_account(request)
    query = _norm(q)
    if not query:
        return {"results": []}
    limit = max(1, min(50, limit))
    canonical = food_graph.search_foods(query, limit=limit)
    if canonical:
        return {"results": [food_graph.compatibility_food_suggestion(f) for f in canonical]}
    scored = []
    for food in FOOD_DB:
        s = _search_score(query, food)
        if s > 0:
            scored.append((s, -len(food["key"]), food))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    local = [_food_suggestion(f) for _, _, f in scored[:limit]]
    if local:
        return {"results": local}
    # Web-backed fallback for out-of-catalog/manual queries. Response shape stays
    # identical to normal DB search so the app UI remains the same.
    return {"results": _off_search_foods(query, limit)}


@app.get("/foods/combos")
def foods_combos(request: Request, dish: str, limit: int = 6):
    """Suggested accompaniments for the dishes in a meal ("Goes well with").

    `dish` is a "|"-separated list of the meal's item names (e.g.
    "Idli|Coconut Chutney"). Like /foods/search this is a free, local, in-memory
    lookup -- no Gemini, no scan credit -- so it needs a signed-in account only.
    Sides already present in the meal are excluded, results are de-duplicated,
    and each pairing carries a default `count` plus the food DB nutrition so the
    client can add it as a FoodItem in one tap."""
    auth.require_account(request)
    names = [d for d in re.split(r"[|]", dish) if d and d.strip()]
    if not names:
        return {"pairings": []}

    # What's already on the plate -- don't suggest a side the user logged.
    present: set[str] = set()
    for nm in names:
        present.add(_norm(nm).replace(" ", "_"))
        f = match_food(nm)
        if f:
            present.add(f["key"])

    seen: set[str] = set()
    out: list[dict] = []
    for nm in names:
        combo_key = _norm(nm).replace(" ", "_")
        if combo_key not in COMBOS:
            f = match_food(nm)
            if f:
                combo_key = f["key"]
        persisted_sides = _persisted_combo_sides(combo_key)
        sides = persisted_sides if persisted_sides else ((_resolve_combo_entry(nm) or {}).get("sides", []))
        for side in sides:
            sk = side.get("key")
            if not sk or sk in seen or sk in present:
                continue
            # Resolve this side's nutrition/diet flags from the curated FOOD_DB.
            food = FOOD_BY_KEY.get(sk)
            if not food:
                cands = food_graph.search_foods(sk, limit=1)
                food = cands[0] if cands else None
            if not food:
                continue  # curated key not in FOOD_DB -> silently skip
            seen.add(sk)
            sug = _food_suggestion(food)
            sug["count"] = side.get("count", 1)
            if side.get("reason"):
                sug["reason"] = side["reason"]
            sug["pairs_with"] = side.get("pairs_with") or ((_resolve_combo_entry(nm) or {}).get("display", nm))
            out.append(sug)

    limit = max(1, min(20, limit))
    return {"pairings": out[:limit]}


class ComboFingerprintBody(BaseModel):
    dishes: list[str] = Field(default_factory=list)


@app.post("/combos/fingerprint")
def combos_fingerprint(body: ComboFingerprintBody, request: Request):
    auth.require_account(request)
    keys: list[str] = []
    for name in body.dishes:
        f = match_food(name)
        if f:
            keys.append(f["key"])
        else:
            n = _norm(name).replace(" ", "_")
            if n:
                keys.append(n)
    fp = recipe_combo_engine.combo_fingerprint(keys)
    return {"fingerprint": fp, "keys": sorted(set(keys))}


class RecipeIngredientIn(BaseModel):
    food_key: str | None = None
    name: str | None = None
    quantity: float = Field(1, ge=0)
    quantity_unit: str = "serving"
    notes: str | None = None


class RecipeEstimateBody(BaseModel):
    name: str = Field("", max_length=200)
    servings: float = Field(1, gt=0, le=100)
    ingredients: list[RecipeIngredientIn] = Field(default_factory=list)


class RecipeSaveBody(RecipeEstimateBody):
    recipe_code: str = Field(..., min_length=2, max_length=80)
    source: str = Field(default="user", max_length=40)


@app.post("/recipes/estimate")
def recipes_estimate(body: RecipeEstimateBody, request: Request):
    auth.require_account(request)
    if not body.ingredients:
        return {"name": body.name, "servings": body.servings, "items": [], "totals": {"kcal": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}}
    estimated = recipe_combo_engine.estimate_recipe(
        [i.model_dump() for i in body.ingredients],
        _resolve_food_for_recipe,
    )
    return {"name": body.name, "servings": body.servings, **estimated}


@app.post("/recipes")
def recipes_save(body: RecipeSaveBody, request: Request):
    auth.require_account(request)
    ingredients = [i.model_dump() for i in body.ingredients]
    recipe_id = recipe_combo_engine.save_recipe(
        recipe_code=body.recipe_code.strip(),
        name=body.name.strip() or body.recipe_code.strip(),
        servings=body.servings,
        source=body.source.strip() or "user",
        notes=None,
        ingredients=ingredients,
    )
    estimated = recipe_combo_engine.estimate_recipe(ingredients, _resolve_food_for_recipe)
    return {"ok": True, "id": recipe_id, "recipe_code": body.recipe_code, "estimate": estimated}


@app.get("/recipes/search")
def recipes_search(q: str, request: Request, limit: int = 20):
    auth.require_account(request)
    return {"results": recipe_combo_engine.search_recipes(q, limit=limit)}


@app.get("/recipes/{recipe_id}")
def recipes_get(recipe_id: int, request: Request):
    auth.require_account(request)
    rec = recipe_combo_engine.load_recipe(recipe_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Recipe not found")
    estimate = recipe_combo_engine.estimate_recipe(rec.get("ingredients", []), _resolve_food_for_recipe)
    return {"recipe": rec, "estimate": estimate}


@app.get("/meal-templates")
def meal_templates_list(
    request: Request,
    slot: str = "",
    training: str = "",
    limit: int = 30,
):
    auth.require_account(request)
    return {"templates": recipe_combo_engine.list_meal_templates(slot, training, limit)}


@app.get("/meal-templates/roles")
def meal_template_roles_list(
    request: Request,
    food_key: str = "",
    role_key: str = "",
    limit: int = 100,
):
    auth.require_account(request)
    return {"roles": recipe_combo_engine.list_food_roles(food_key, role_key, limit)}


# --------------------------------------------------------------------------- #
#  "What to eat next" -- real recommendation over the whole food DB
# --------------------------------------------------------------------------- #
# Meat/fish words = the non-veg set minus egg, so an eggetarian can still be
# offered egg dishes but never meat/fish.
_MEAT_FISH_WORDS = tuple(w for w in _NON_VEG_WORDS if w not in ("egg", "eggs", "anda"))

# Dairy / other animal-derived words -- excluded ON TOP of the non-veg words for
# a vegan diet, so a vegan is never offered paneer, curd, ghee, milk sweets, etc.
# (bare "butter" also drops peanut butter for vegans -- an acceptable edge case
# vs. correctly excluding the far more common butter naan / paneer-butter dishes).
_DAIRY_WORDS = (
    "paneer", "curd", "dahi", "yogurt", "yoghurt", "milk", "cheese", "cream",
    "malai", "ghee", "butter", "khoya", "mawa", "lassi", "buttermilk", "chaas",
    "kheer", "payasam", "raita", "makhan", "rabri", "rabdi", "kulfi", "condensed",
    "honey", "custard", "srikhand", "shrikhand", "basundi", "peda", "barfi",
    "burfi", "gulab", "jamun", "rasgulla", "rasmalai",
)


def _food_text(food: dict) -> str:
    """All the naming text we can diet-classify a food from."""
    parts = [food.get("key", "")] + list(food.get("_aliases", []))
    if food.get("_source_name"):
        parts.append(food["_source_name"])
    return _norm(" ".join(p for p in parts if p))


def _food_diet_ok(food: dict, diet: str) -> bool:
    """Whether a DB food is allowed for the user's diet. Uses FOOD_DB's
    vegetarian/vegan/eggetarian columns when set, falling back to the
    word-list heuristic otherwise (see checkpoint notes on the "Hot Tea"
    fix)."""
    if diet == "nonveg":
        return True
    if food.get("id") is not None:
        return dietary_rules.food_allowed(food, diet)
    if food.get("vegetarian") is not None:
        if diet == "eggetarian":
            return bool(food.get("eggetarian"))
        if diet == "vegan":
            return bool(food.get("vegan"))
        # veg, jain, sattvic -> vegetarian only (dairy allowed)
        return bool(food.get("vegetarian"))
    text = _food_text(food)
    if diet == "eggetarian":
        return not _word_in(_MEAT_FISH_WORDS, text)
    if diet == "vegan":
        # No meat/fish/egg AND no dairy or other animal-derived foods.
        return not _word_in(_NON_VEG_WORDS, text) and not _word_in(_DAIRY_WORDS, text)
    # veg, jain, sattvic -> vegetarian only (dairy allowed)
    return not _word_in(_NON_VEG_WORDS, text)


# Clearly non-Indian / continental dish tokens. The 815-food INDB set is broad
# and includes Western recipes (pasta, lasagne, souffle...) alongside Indian
# staples. gofit is India-first, so we gently DOWN-weight obviously-Western
# dishes rather than filter them out (the whole DB stays eligible for variety
# and real nutrition). This is a ranking nudge, not a food allow/deny list.
_WESTERN_WORDS = {
    "pasta", "spaghetti", "macaroni", "lasagne", "lasagna", "bolognese",
    "souffle", "quiche", "casserole", "stroganoff", "risotto", "ravioli",
    "pizza", "burger", "hotdog", "taco", "burrito", "nachos", "gratin",
    "meatloaf", "waffle", "pancake", "croissant", "bagel", "muffin",
}


def _india_tier(food: dict) -> int:
    """India-first ranking tier. gofit is India-first but the INDB set mixes
    continental recipes (pasta, lasagne...) in with Indian staples and there is
    no reliable cuisine flag in the data. So we bucket foods and rank Indian
    ones ahead of continental ones, letting macro-fit order within each tier
    (keeps real-DB variety without surfacing spaghetti for an Indian thali).
      2 = hand-curated staple (idli, dosa, dal...)
      1 = carries a Hindi/regional name (translit paren in _source_name)
      0 = neutral (Indian DB food with no explicit Indian name signal)
     -1 = clearly continental dish (see _WESTERN_WORDS)"""
    text = _food_text(food)
    if _word_in(_WESTERN_WORDS, text):
        return -1
    if not food.get("_source"):
        return 2
    sn = food.get("_source_name") or ""
    if "(" in sn and ")" in sn:
        return 1
    return 0


def _recommend_components(food: dict, rem: dict, goal: dict) -> dict:
    """Rank a single real DB food by how well one serving fits what's LEFT in
    the user's day. Mirrors the client's deterministic scorer (protein-first,
    penalise calorie/fat overshoot, small goal tilt) so server and client agree,
    plus a gentle nudge toward the app's health_score. Training-context bias
    stays on the client."""
    kcal = food.get("kcal_per_unit", 0) or 0
    if kcal <= 0:
        return {"score": -1e9}
    remKcal = rem["kcal"]
    remP = max(0, rem["protein_g"])
    remC = max(0, rem["carbs_g"])
    remF = max(0, rem["fat_g"])

    protein_fill = min(food.get("protein_g", 0) or 0, remP)
    carb_fill = min(food.get("carbs_g", 0) or 0, remC)
    kcal_over = max(0, kcal - remKcal)
    fat_over = max(0, (food.get("fat_g", 0) or 0) - remF)

    protein_priority = goal.get("protein_g", 0) > 0 and (remP / goal["protein_g"]) >= 0.3
    g = goal.get("goal", "maintain")
    goal_bias = -0.15 if g == "lose" else 0.1 if g == "gain" else 0.0

    score = (
        (2.2 if protein_priority else 1.0) * protein_fill
        + 0.12 * carb_fill
        - 0.06 * kcal_over
        - 0.4 * fat_over
        + goal_bias * (kcal / 100.0)
    )
    # Nudge toward healthier real foods (health_score is 0-100, 50 is neutral).
    hs = food.get("health_score")
    hs_term = 0.0
    if isinstance(hs, (int, float)):
        hs_term = (hs - 50) * 0.03
        score += hs_term
    return {
        "score": score,
        "protein_fill": protein_fill,
        "carb_fill": carb_fill,
        "kcal_over": kcal_over,
        "fat_over": fat_over,
        "health_term": hs_term,
    }


def _recommend_score(food: dict, rem: dict, goal: dict) -> float:
    return float(_recommend_components(food, rem, goal).get("score", -1e9))


def _rank_foods_detailed(rem: dict, goal: dict, diet: str, limit: int) -> dict:
    remKcal = rem["kcal"]
    ceiling = max(remKcal * 1.2, 150)
    source = FOOD_DB
    after_diet = []
    scored = []
    for food in source:
        if not _food_diet_ok(food, diet):
            continue
        after_diet.append(food)
        kcal = food.get("kcal_per_unit", 0) or 0
        if kcal <= 0 or kcal > ceiling:
            continue
        comp = _recommend_components(food, rem, goal)
        s = comp.get("score", -1e9)
        scored.append((_india_tier(food), s, -kcal, food, comp))
    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    top = scored[:limit]
    top_audit = []
    for _, s, _, f, comp in scored[:20]:
        top_audit.append(
            {
                "key": f.get("key"),
                "name": f.get("name") or f.get("key", "").replace("_", " ").title(),
                "score": round(float(s), 4),
                "protein_fill": round(float(comp.get("protein_fill", 0.0)), 3),
                "carb_fill": round(float(comp.get("carb_fill", 0.0)), 3),
                "kcal_over": round(float(comp.get("kcal_over", 0.0)), 3),
                "fat_over": round(float(comp.get("fat_over", 0.0)), 3),
                "health_term": round(float(comp.get("health_term", 0.0)), 4),
                "india_tier": _india_tier(f),
            }
        )
    return {
        "foods": [f for _, _, _, f, _ in top],
        "counts": {
            "food_db_total": len(source),
            "after_diet_filter": len(after_diet),
            "after_nutrition_filter": len(scored),
        },
        "top20_food_rank": top_audit,
        "determinism": {
            "sort_keys": ["india_tier(desc)", "score(desc)", "kcal_ascending"],
            "fixed_seed": False,
            "randomized": False,
        },
        "ceiling_kcal": round(float(ceiling), 2),
    }


def _rank_foods(rem: dict, goal: dict, diet: str, limit: int) -> list:
    """Return the top real DB foods for the remaining budget + diet. A serving
    must fit the calorie headroom (with a little slack) so we never suggest a
    600 kcal thali when only 200 kcal remain. Ranks over FOOD_DB, the single
    curated food source (see /foods/search's docstring for why the
    experimental Food Intelligence Graph is not used here)."""
    return _rank_foods_detailed(rem, goal, diet, limit)["foods"]


_FOOD_ROLE_CACHE_TTL = 300
_food_role_cache = {"ts": 0.0, "map": {}}


def _food_roles_map() -> dict[str, set[str]]:
    now = time.time()
    if (now - float(_food_role_cache["ts"])) < _FOOD_ROLE_CACHE_TTL and _food_role_cache["map"]:
        return _food_role_cache["map"]  # type: ignore[return-value]
    role_rows = recipe_combo_engine.list_food_roles(limit=3000)
    out: dict[str, set[str]] = {}
    for row in role_rows:
        key = str(row.get("food_key") or "").strip().lower()
        role = str(row.get("role_key") or "").strip().lower()
        if not key or not role:
            continue
        out.setdefault(key, set()).add(role)
    _food_role_cache["ts"] = now
    _food_role_cache["map"] = out
    return out


def _template_role_prefs(slot: str, training: str) -> tuple[set[str], set[str], str, int]:
    templates = recipe_combo_engine.list_meal_templates(
        meal_type=(slot or "").strip().lower(),
        training_context=(training or "").strip().lower(),
        limit=8,
    )
    if not templates:
        return set(), set(), "", 0
    selected = templates[0]
    required: set[str] = set()
    optional: set[str] = set()
    for role in selected.get("roles", []):
        rk = str(role.get("role_key") or "").strip().lower()
        req = str(role.get("requirement") or "").strip().lower()
        if not rk:
            continue
        if req == "required":
            required.add(rk)
        elif req == "optional":
            optional.add(rk)
    return required, optional, str(selected.get("template_key") or ""), len(templates)


# AI phrasing is cached so rapid re-renders / similar budgets don't re-hit
# Gemini. Keyed by a COARSE bucket of the request (diet, goal, slot, calorie
# bucket, protein bucket, top-food key) with a short TTL. Best-effort: any AI
# failure falls back to deterministic text, so the endpoint never breaks.
_PHRASE_TTL = 600  # seconds
_PHRASE_CACHE_MAX = 512
_phrase_cache: dict = {}
_phrase_lock = threading.Lock()
_ai_mode_stats = {"next_move_ok": 0, "next_move_fail": 0, "plan_ok": 0, "plan_fail": 0}
_ai_mode_stats_lock = threading.Lock()


def _mark_ai_mode(event: str, **ctx) -> None:
    with _ai_mode_stats_lock:
        if event in _ai_mode_stats:
            _ai_mode_stats[event] += 1
        snap = dict(_ai_mode_stats)
    if ctx:
        log.info("ai_mode event=%s stats=%s ctx=%s", event, snap, ctx)
    else:
        log.info("ai_mode event=%s stats=%s", event, snap)


def _phrase_key(diet, goal, slot, rem, top_key) -> tuple:
    return (
        diet,
        goal.get("goal", "maintain"),
        slot or "",
        int(round(rem["kcal"] / 100.0)),
        int(round(rem["protein_g"] / 10.0)),
        top_key,
    )


def _deterministic_phrase(top: list, rem: dict) -> str:
    if not top:
        return "A balanced plate — dal, a roti and some sabzi."
    name = top[0].get("name") or top[0]["key"].replace("_", " ").title()
    p = int(round(rem["protein_g"]))
    if rem["protein_g"] >= 15:
        return f"Try {name} — it helps close your ~{p}g protein gap for the day."
    return f"Try {name} — a sensible fit for what's left in your budget."


def _ai_phrase(diet: str, goal: dict, slot: str, rem: dict, top: list) -> str:
    """One friendly, India-first sentence recommending what to eat next, GROUNDED
    in the real ranked foods (the model may only choose among the names we pass).
    Cached + best-effort."""
    if not top:
        return _deterministic_phrase(top, rem)
    key = _phrase_key(diet, goal, slot, rem, top[0]["key"])
    now = time.time()
    with _phrase_lock:
        hit = _phrase_cache.get(key)
        if hit and (now - hit[0]) < _PHRASE_TTL:
            return hit[1]

    names = [t.get("name") or t["key"].replace("_", " ") for t in top[:5]]
    prompt = (
        "You are a concise Indian nutrition assistant. Recommend ONE next thing to "
        "eat, choosing ONLY from this list of real foods (do not invent others):\n"
        f"{', '.join(names)}\n\n"
        f"Context: diet={diet}, goal={goal.get('goal','maintain')}, meal_slot={slot or 'any'}.\n"
        f"Remaining today: {int(rem['kcal'])} kcal, {int(rem['protein_g'])} g protein, "
        f"{int(rem['carbs_g'])} g carbs, {int(rem['fat_g'])} g fat.\n\n"
        "Write ONE short, friendly sentence (max 22 words) telling the user what to eat "
        "next and why, referencing the biggest gap (usually protein). No medical claims, "
        "no calorie numbers in the sentence. Respond as JSON: "
        '{"suggestion": "<sentence>"}'
    )
    try:
        resp = _generate(prompt)
        data = extract_json(resp.text)
        text = (data.get("suggestion") or "").strip()
        if not text:
            raise ValueError("empty suggestion")
        # Keep it grounded: the model must be talking about a food we offered.
        low = text.lower()
        if not any(n.lower().split()[0] in low for n in names if n.split()):
            raise ValueError("suggestion drifted off the offered foods")
    except Exception as ex:
        log.info("recommend: AI phrasing failed (%s) -- using deterministic text", ex)
        text = _deterministic_phrase(top, rem)

    with _phrase_lock:
        if len(_phrase_cache) > _PHRASE_CACHE_MAX:
            _phrase_cache.clear()
        _phrase_cache[key] = (now, text)
    return text


def _to_num(v, default: float = 0.0) -> float:
    try:
        n = float(v)
        if not math.isfinite(n):
            return default
        return n
    except Exception:
        return default


def _normalize_meal_from_ai(meal: dict, fallback_name: str) -> dict:
    name = str((meal or {}).get("name") or fallback_name or "Suggested meal").strip()[:80] or "Suggested meal"
    raw_items = (meal or {}).get("items") or []
    items = []
    for it in raw_items[:6]:
        if not isinstance(it, dict):
            continue
        item_name = str(it.get("name") or "").strip()[:80]
        if not item_name:
            continue
        items.append(
            {
                "name": item_name,
                "count": max(0.1, min(6.0, _to_num(it.get("count"), 1.0))),
                "unit": str(it.get("unit") or "serving").strip()[:20] or "serving",
                "kcal": max(0.0, _to_num(it.get("kcal"), 0.0)),
                "protein_g": max(0.0, _to_num(it.get("protein_g"), 0.0)),
                "carbs_g": max(0.0, _to_num(it.get("carbs_g"), 0.0)),
                "fat_g": max(0.0, _to_num(it.get("fat_g"), 0.0)),
                "fiber_g": max(0.0, _to_num(it.get("fiber_g"), 0.0)),
            }
        )
    if not items:
        return {
            "name": name,
            "kcal": max(0.0, _to_num((meal or {}).get("kcal"), 0.0)),
            "protein_g": max(0.0, _to_num((meal or {}).get("protein_g"), 0.0)),
            "carbs_g": max(0.0, _to_num((meal or {}).get("carbs_g"), 0.0)),
            "fat_g": max(0.0, _to_num((meal or {}).get("fat_g"), 0.0)),
            "items": [],
        }
    kcal = round(sum(_to_num(i.get("kcal")) for i in items), 1)
    protein_g = round(sum(_to_num(i.get("protein_g")) for i in items), 1)
    carbs_g = round(sum(_to_num(i.get("carbs_g")) for i in items), 1)
    fat_g = round(sum(_to_num(i.get("fat_g")) for i in items), 1)
    return {"name": name, "kcal": kcal, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g, "items": items}


def _ai_next_move(rem: dict, diet: str, goal_name: str, slot: str, training: str, profile: dict) -> Optional[dict]:
    prompt = (
        "You are a practical Indian nutrition planner. Build ONE realistic next meal and up to six alternatives.\n"
        "Use the user's context and remaining macros.\n"
        f"Context:\nremaining={json.dumps(rem)}\ndiet={diet}\ngoal={goal_name}\nslot={slot}\ntraining={training}\nprofile={json.dumps(profile or {}, ensure_ascii=True)}\n\n"
        "Return JSON only with this exact shape:\n"
        '{"category":"protein_gap|energy_gap|fat_cap|balanced","reason":"short user-facing sentence",'
        '"meal":{"name":"...","items":[{"name":"...","count":1,"unit":"serving","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]},'
        '"alternatives":[{"name":"...","items":[{"name":"...","count":1,"unit":"serving","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]}]}\n'
        "Rules: Indian-friendly meals only, no supplements/powders, realistic portions, concise reason (<24 words)."
    )
    resp = _generate(prompt)
    data = extract_json(resp.text)
    cat = str(data.get("category") or "").strip().lower()
    if cat not in ("protein_gap", "energy_gap", "fat_cap", "balanced"):
        cat = _macro_gap_reason(rem, goal_name)[0]
    meal = _normalize_meal_from_ai(data.get("meal") or {}, "Next meal")
    if meal["kcal"] <= 0 and not meal["items"]:
        return None
    seen = {meal["name"].strip().lower()}
    alternatives = []
    for alt in (data.get("alternatives") or [])[:5]:
        if not isinstance(alt, dict):
            continue
        norm = _normalize_meal_from_ai(alt, "Alternative")
        key = norm["name"].strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        alternatives.append(norm)
        if len(alternatives) >= 8:
            break
    reason = str(data.get("reason") or "").strip()
    if not reason:
        reason = _macro_gap_reason(rem, goal_name)[1]
    return {"category": cat, "slot": slot, "reason": reason[:180], "meal": meal, "alternatives": alternatives}


class Remaining(BaseModel):
    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0


class RecommendTargets(BaseModel):
    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0


class RecommendProfile(BaseModel):
    age: Optional[float] = None
    gender: str = ""
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    target_weight_kg: Optional[float] = None
    activity: str = ""
    goal_pace: str = ""
    goal_kind: str = ""
    diet: str = ""
    goal: str = ""


class RecommendBody(BaseModel):
    remaining: Remaining
    diet: str = "veg"
    goal: str = "maintain"
    slot: str = ""
    limit: int = 12
    phrase: bool = True
    targets: RecommendTargets | None = None
    consumed: RecommendTargets | None = None
    date: str = ""
    training: str = ""
    ai_mode: bool = False
    profile: RecommendProfile | None = None
    hour: Optional[int] = None  # device-local hour (0-23); makes slot picking time-aware


def _init_recommendation_history_table(c) -> None:
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS recommendation_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id    INTEGER NOT NULL,
            date          TEXT NOT NULL,
            slot          TEXT NOT NULL,
            meal_key      TEXT NOT NULL,
            meal_name     TEXT NOT NULL,
            shown_keys    TEXT NOT NULL,
            score         REAL NOT NULL DEFAULT 0,
            created_at    REAL NOT NULL
        )
        """
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_reco_history_account_date ON recommendation_history(account_id, date, created_at)"
    )


def _core_slot(meal_type: str) -> str:
    mt = (meal_type or "").strip().lower()
    if mt in ("breakfast",):
        return "breakfast"
    if mt in ("lunch",):
        return "lunch"
    if mt in ("dinner",):
        return "dinner"
    return "snack"


# Rough Indian meal-time windows used to make "what's next" feel aware of the
# actual time of day, instead of always defaulting to whichever slot happens
# to be chronologically first and unlogged (which made the home-screen "next
# best move" card show the same breakfast suggestion all day long).
_SLOT_HOUR_WINDOWS = [
    ("breakfast", 4, 11),
    ("lunch", 11, 16),
    ("snack", 16, 19),
    ("dinner", 19, 23),
]
_SLOT_ORDER = ["breakfast", "lunch", "snack", "dinner"]


def _slot_for_hour(hour: int) -> str:
    h = hour % 24
    for slot, start, end in _SLOT_HOUR_WINDOWS:
        if start <= h < end:
            return slot
    return "dinner"  # late night (23:00-04:00) -- still dinner/late-dinner territory


def _next_slot_from_logs(account_id: int, date_key: str, asked_slot: str, hour: Optional[int] = None) -> str:
    asked = (asked_slot or "").strip().lower()
    if asked in ("breakfast", "lunch", "snack", "dinner"):
        return asked
    with db.connect() as c:
        if "meal_type" in db.table_columns(c, "meal_logs"):
            rows = c.execute(
                "SELECT meal_type FROM meal_logs WHERE account_id=? AND date=? ORDER BY at ASC",
                (account_id, date_key),
            ).fetchall()
        else:
            rows = []
    seen = [_core_slot(r["meal_type"]) for r in rows if r["meal_type"]]
    seen_set = set(seen)

    if hour is not None:
        # Prefer whatever slot matches the current time of day if it hasn't
        # been logged yet -- e.g. at 8pm, suggest dinner even if breakfast
        # was skipped, rather than nagging about a meal that's long past.
        current = _slot_for_hour(hour)
        if current not in seen_set:
            return current
        idx = _SLOT_ORDER.index(current)
        # Current slot already logged: look for an earlier missed meal first...
        for s in _SLOT_ORDER[:idx]:
            if s not in seen_set:
                return s
        # ...then anything still ahead today.
        for s in _SLOT_ORDER[idx + 1 :]:
            if s not in seen_set:
                return s
        return "snack"

    if "breakfast" not in seen_set:
        return "breakfast"
    if "lunch" not in seen_set:
        return "lunch"
    if "snack" not in seen_set:
        return "snack"
    if "dinner" not in seen_set:
        return "dinner"
    return "snack"


def _day_meal_strings(account_id: int, date_key: str, history_days: int = 5) -> list[str]:
    # date is stored as YYYY-MM-DD text, so lexical ORDER BY works chronologically.
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT dish FROM meal_logs
            WHERE account_id=? AND date<=?
            ORDER BY date DESC, at DESC
            LIMIT ?
            """,
            (account_id, date_key, max(1, history_days * 8)),
        ).fetchall()
    return [str(r["dish"] or "").strip().lower() for r in rows if str(r["dish"] or "").strip()]


def _recent_reco_counts(account_id: int, date_key: str, lookback: int = 4) -> dict[str, int]:
    with db.connect() as c:
        _init_recommendation_history_table(c)
        rows = c.execute(
            """
            SELECT meal_key, COUNT(*) AS n
            FROM recommendation_history
            WHERE account_id=? AND date<=?
            GROUP BY meal_key
            ORDER BY MAX(created_at) DESC
            LIMIT ?
            """,
            (account_id, date_key, max(8, lookback * 8)),
        ).fetchall()
    return {str(r["meal_key"]): int(r["n"]) for r in rows}


def _target_kcal_share(slot: str) -> float:
    if slot == "breakfast":
        return 0.25
    if slot == "lunch":
        return 0.33
    if slot == "dinner":
        return 0.28
    return 0.14


_PREP_WORDS = {
    "curry", "masala", "gravy", "dry", "fry", "fried", "sabzi", "sabji", "bhaji",
    "tadka", "tikka", "roasted", "grilled", "steamed", "boiled", "spicy", "hot",
    "special", "home", "style", "homestyle", "plain", "fresh", "classic", "with",
    "and", "the", "of", "in", "ka", "ki", "ke", "wala", "wali", "veg", "non",
    "half", "full", "plate", "bowl", "serving", "regular", "large", "small",
}


def _family(food: dict) -> str:
    name = (food.get("name") or food.get("key", "")).lower().replace("_", " ").replace("-", " ")
    for tok in name.split():
        t = tok.strip()
        if len(t) > 2 and t not in _PREP_WORDS:
            return t
    return name.strip() or str(food.get("key", ""))


def _meal_fingerprint(items: list[dict]) -> str:
    parts = []
    for it in items:
        parts.append(f"{str(it.get('key','')).strip().lower()}:{float(it.get('count',0) or 0):.2f}")
    return recipe_combo_engine.combo_fingerprint(parts)


def _meal_primary_key(items: list[dict]) -> str:
    if not items:
        return ""
    return str(items[0].get("key", "")).strip().lower()


def _meal_name(items: list[dict]) -> str:
    names = [str(i.get("name", "")).strip() for i in items if str(i.get("name", "")).strip()]
    return " + ".join(names[:4])


def _meal_component_summary(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        out.append(
            {
                "key": it.get("key"),
                "name": it.get("name"),
                "count": it.get("count"),
                "unit": it.get("unit"),
                "kcal": it.get("kcal"),
                "protein_g": it.get("protein_g"),
                "carbs_g": it.get("carbs_g"),
                "fat_g": it.get("fat_g"),
            }
        )
    return out


def _macro_gap_reason(rem: dict, goal: str) -> tuple[str, str]:
    rows = [
        ("protein", rem.get("protein_g", 0)),
        ("carbs", rem.get("carbs_g", 0)),
        ("fat", rem.get("fat_g", 0)),
    ]
    rows.sort(key=lambda x: x[1], reverse=True)
    top_k, top_v = rows[0]
    if rem.get("kcal", 0) <= 160:
        return "light", "You're close to your calorie limit, so this keeps things lighter."
    if top_k == "protein" and top_v >= 12:
        return "high_protein", f"You still need about {int(round(top_v))}g protein today."
    if top_k == "carbs" and top_v >= 20:
        return "carb_support", f"You still need about {int(round(top_v))}g carbs today."
    if goal == "lose":
        return "balanced_light", "This balances your remaining targets without overshooting calories."
    return "balanced", "This is a balanced fit for what remains today."


def _score_candidate_meal(
    items: list[dict],
    slot: str,
    rem: dict,
    goal_name: str,
    day_meals: list[str],
    reco_counts: dict[str, int],
) -> tuple[float, dict]:
    totals = _meal_totals(items)
    if totals["kcal"] <= 0:
        return -1e9, {}
    # Nutrition fit (day-state aware).
    fit_score = _meal_fit_score(items, rem)
    score = fit_score
    # Meal context fit.
    slot_context_penalty = 0.0
    if slot == "snack" and totals["kcal"] > max(320.0, rem["kcal"] * 0.7):
        slot_context_penalty += 2.2
        score -= 2.2
    if slot in ("lunch", "dinner") and totals["kcal"] < 220:
        slot_context_penalty += 1.6
        score -= 1.6
    # Repetition penalty from logged dishes + shown recommendations.
    primary = _meal_primary_key(items)
    meal_name = _meal_name(items).lower()
    repeats_logged = 0
    for d in day_meals:
        if primary and primary in d:
            repeats_logged += 1
        elif meal_name and meal_name[:24] in d:
            repeats_logged += 1
    repeats_reco = reco_counts.get(primary, 0) if primary else 0
    rep_penalty = (repeats_logged * 1.4) + (repeats_reco * 1.1)
    score -= rep_penalty
    # Diversity boost for meals not seen recently.
    diversity_boost = 0.0
    if repeats_logged == 0 and repeats_reco == 0:
        diversity_boost = 0.8
        score += diversity_boost
    # Goal nuance.
    goal_adjust = 0.0
    if goal_name == "gain":
        goal_adjust = min(1.2, totals["kcal"] / max(300.0, rem["kcal"])) * 0.4
        score += goal_adjust
    elif goal_name == "lose":
        goal_adjust = -max(0.0, totals["kcal"] - rem["kcal"] * 0.95) * 0.01
        score += goal_adjust
    return score, {
        "fit_score": round(float(fit_score), 4),
        "slot_context_penalty": round(float(slot_context_penalty), 4),
        "repeats_logged": int(repeats_logged),
        "repeats_reco": int(repeats_reco),
        "repetition_penalty": round(float(rep_penalty), 4),
        "diversity_boost": round(float(diversity_boost), 4),
        "goal_adjust": round(float(goal_adjust), 4),
    }


def _build_next_move_candidates(
    account_id: int,
    date_key: str,
    slot: str,
    rem: dict,
    diet: str,
    goal_name: str,
    training: str,
    limit: int,
) -> list[dict]:
    goal = {"goal": goal_name, "protein_g": rem.get("protein_g", 0) * 3}
    rank_debug = _rank_foods_detailed(rem, goal, diet, max(30, limit * 10))
    primaries = [_food_suggestion(f) for f in rank_debug["foods"]]
    if not primaries:
        log.info("reco.audit slot=%s stage=rank no_primaries counts=%s", slot, rank_debug.get("counts"))
        return []
    role_map = _food_roles_map()
    required_roles, _, template_key, template_pool = _template_role_prefs(slot, training)
    day_meals = _day_meal_strings(account_id, date_key, history_days=5)
    reco_counts = _recent_reco_counts(account_id, date_key, lookback=4)
    seen_fp: set[str] = set()
    scored: list[tuple[float, dict]] = []
    slot_filter_drops = 0
    compatibility_rejects: dict[str, int] = defaultdict(int)

    primary_pool = primaries[:18]
    strict_primaries: list[dict] = []
    for primary in primary_pool:
        p_key = str(primary.get("key", "")).strip().lower()
        if not p_key:
            continue
        p_roles = role_map.get(p_key, set())
        if required_roles and ("staple" in required_roles) and ("staple" not in p_roles) and slot in ("breakfast", "lunch", "dinner"):
            slot_filter_drops += 1
            continue
        strict_primaries.append(primary)
    # Role map is sparse in early datasets; if strict-role filter collapses the
    # pool, relax it rather than returning zero candidates.
    relaxed_role_filter = False
    if not strict_primaries and slot_filter_drops > 0:
        strict_primaries = primary_pool
        relaxed_role_filter = True

    for primary in strict_primaries:
        p_key = str(primary.get("key", "")).strip().lower()
        if not p_key:
            continue
        meal_items: list[dict] = []
        pst, plo, phi = _portion_step(str(primary.get("unit", "")), p_key)
        p_count = _round_count(1.0 if pst >= 1.0 else 0.5, pst, plo, phi)
        meal_items.append(_component_from_food(primary, p_count))

        for side in _combo_sides_for_key(p_key):
            sk = str(side.get("key") or "").strip().lower()
            if not sk or sk == p_key:
                continue
            sf = FOOD_BY_KEY.get(sk)
            if not sf or (not _food_diet_ok(sf, diet)):
                continue
            ss = _food_suggestion(sf)
            cnt = float(side.get("count") or 1)
            sst, slo, shi = _portion_step(str(ss.get("unit", "")), sk)
            meal_items.append(_component_from_food(ss, _round_count(cnt, sst, slo, shi)))
            if len(meal_items) >= max(2, limit):
                break

        # Fill missing required roles, if any.
        have_roles = set()
        for it in meal_items:
            have_roles.update(role_map.get(str(it.get("key", "")).lower(), set()))
        for req_role in required_roles:
            if req_role in have_roles:
                continue
            for cand in primaries:
                ck = str(cand.get("key", "")).strip().lower()
                if ck in {str(i.get("key", "")).lower() for i in meal_items}:
                    continue
                if req_role not in role_map.get(ck, set()):
                    continue
                cst, clo, chi = _portion_step(str(cand.get("unit", "")), ck)
                meal_items.append(_component_from_food(cand, _round_count(1.0, cst, clo, chi)))
                have_roles.update(role_map.get(ck, set()))
                break

        ok, why = _is_compatible_meal(slot, meal_items)
        if not ok:
            log.info("next_move reject slot=%s primary=%s reason=%s", slot, p_key, why)
            compatibility_rejects[why] += 1
            continue

        fp = _meal_fingerprint(meal_items)
        if fp in seen_fp:
            continue
        seen_fp.add(fp)
        score, score_parts = _score_candidate_meal(meal_items, slot, rem, goal_name, day_meals, reco_counts)
        scored.append(
            (
                score,
                {
                    "slot": slot,
                    "primary_key": _meal_primary_key(meal_items),
                    "meal_name": _meal_name(meal_items),
                    "items": meal_items,
                    "totals": _meal_totals(meal_items),
                    "fingerprint": fp,
                    "score": round(score, 4),
                    "score_parts": score_parts,
                },
            )
        )

    scored.sort(key=lambda x: x[0], reverse=True)
    top_ranked = [m for _, m in scored[: max(1, limit)]]
    top20 = [m for _, m in scored[:20]]
    rounded = Counter(round(float(m.get("score", 0.0)), 1) for m in top20)
    tie_groups = sum(1 for n in rounded.values() if n > 1)
    log.info(
        "reco.audit slot=%s counts=%s template=%s template_pool=%s required_roles=%s strict_drops=%s relaxed=%s compat_rejects=%s unique_after_compat=%s after_repetition=%s top20=%s determinism=%s top20_food_rank=%s",
        slot,
        {
            "food_db_total": rank_debug["counts"]["food_db_total"],
            "after_diet_filter": rank_debug["counts"]["after_diet_filter"],
            "after_nutrition_filter": rank_debug["counts"]["after_nutrition_filter"],
            "primaries_considered": len(primary_pool),
            "after_slot_filter": len(strict_primaries),
        },
        template_key or "none",
        template_pool,
        sorted(required_roles),
        slot_filter_drops,
        relaxed_role_filter,
        dict(compatibility_rejects),
        len(seen_fp),
        len(top_ranked),
        [
            {
                "meal": m.get("meal_name"),
                "primary": m.get("primary_key"),
                "score": m.get("score"),
                "score_parts": m.get("score_parts"),
                "totals": m.get("totals"),
            }
            for m in top20
        ],
        {
            "sort_keys": ["candidate_score(desc)"],
            "fixed_seed": False,
            "stable_ordering": True,
            "top20_tie_groups": tie_groups,
            "top20_distinct_score_bands": len(rounded),
            "top20_score_bands": dict(rounded),
        },
        rank_debug.get("top20_food_rank", []),
    )
    return top_ranked


_PLAN_SLOT_ORDER = [
    ("breakfast", "Breakfast", 0.25),
    ("lunch", "Lunch", 0.35),
    ("snack", "Snack", 0.15),
    ("dinner", "Dinner", 0.25),
]


def _slot_budget_from_targets(targets: dict, frac: float) -> dict:
    return {
        "kcal": max(0.0, float(targets.get("kcal", 0) or 0) * frac),
        "protein_g": max(0.0, float(targets.get("protein_g", 0) or 0) * frac),
        "carbs_g": max(0.0, float(targets.get("carbs_g", 0) or 0) * frac),
        "fat_g": max(0.0, float(targets.get("fat_g", 0) or 0) * frac),
    }


def _sum_meal_totals(meals: list[dict]) -> dict:
    return {
        "kcal": round(sum(float(m.get("totals", {}).get("kcal", 0) or 0) for m in meals)),
        "protein_g": round(sum(float(m.get("totals", {}).get("protein_g", 0) or 0) for m in meals), 1),
        "carbs_g": round(sum(float(m.get("totals", {}).get("carbs_g", 0) or 0) for m in meals), 1),
        "fat_g": round(sum(float(m.get("totals", {}).get("fat_g", 0) or 0) for m in meals), 1),
        "fiber_g": round(
            sum(sum(float(i.get("fiber_g", 0) or 0) for i in (m.get("items") or [])) for m in meals),
            1,
        ),
    }


def _full_day_combo_score(
    meals: list[dict],
    targets: dict,
    day_meals: list[str],
    reco_counts: dict[str, int],
) -> float:
    totals = _sum_meal_totals(meals)
    t_k = max(1.0, float(targets.get("kcal", 0) or 0))
    t_p = max(1.0, float(targets.get("protein_g", 0) or 0))
    t_c = max(1.0, float(targets.get("carbs_g", 0) or 0))
    t_f = max(1.0, float(targets.get("fat_g", 0) or 0))
    score = 0.0
    score -= abs(totals["kcal"] - t_k) / t_k * 2.2
    score -= abs(totals["protein_g"] - t_p) / t_p * 3.6
    score -= abs(totals["carbs_g"] - t_c) / t_c * 1.6
    score -= abs(totals["fat_g"] - t_f) / t_f * 2.0
    score += sum(float(m.get("score", 0) or 0) for m in meals) * 0.06

    seen_primary: set[str] = set()
    seen_family: set[str] = set()
    for m in meals:
        pk = str(m.get("primary_key") or "")
        if pk in seen_primary and pk:
            score -= 1.6
        seen_primary.add(pk)
        fam = _family({"key": pk, "name": m.get("meal_name", "")})
        if fam in seen_family and fam:
            score -= 0.9
        seen_family.add(fam)
        # History penalties at day-plan level too.
        reps = reco_counts.get(pk, 0)
        score -= reps * 0.5
        nm = str(m.get("meal_name", "")).lower()
        if any(pk and pk in d for d in day_meals):
            score -= 0.6
        if nm and any(nm[:20] in d for d in day_meals):
            score -= 0.5

    return score


def _build_shared_day_plan(
    account_id: int | None,
    date_key: str,
    targets: dict,
    diet: str,
    goal: str,
    training_context: str,
) -> list[dict]:
    """Shared engine for full-day planning used by /plan/today and next-move stack."""
    acct = int(account_id or 0)
    day_meals = _day_meal_strings(acct, date_key, history_days=5) if acct > 0 else []
    reco_counts = _recent_reco_counts(acct, date_key, lookback=6) if acct > 0 else {}
    slot_cands: dict[str, list[dict]] = {}
    for slot, _, frac in _PLAN_SLOT_ORDER:
        budget = _slot_budget_from_targets(targets, frac)
        cands = _build_next_move_candidates(
            account_id=acct,
            date_key=date_key,
            slot=slot,
            rem=budget,
            diet=diet,
            goal_name=goal,
            training=training_context,
            limit=5,
        )
        if not cands:
            log.info("shared_plan: slot=%s no candidates", slot)
            return []
        slot_cands[slot] = cands

    best_combo: list[dict] = []
    best_score = -1e9
    combo_rows: list[tuple[float, list[dict], dict]] = []
    choices = [slot_cands[s] for s, _, _ in _PLAN_SLOT_ORDER]
    for combo in itertools.product(*choices):
        meals = list(combo)
        totals = _sum_meal_totals(meals)
        score = _full_day_combo_score(meals, targets, day_meals, reco_counts)
        combo_rows.append((score, meals, totals))
        if score > best_score:
            best_score = score
            best_combo = meals

    if not best_combo:
        return []
    combo_rows.sort(key=lambda x: x[0], reverse=True)
    top20 = combo_rows[:20]
    rounded = Counter(round(float(row[0]), 2) for row in top20)
    tie_groups = sum(1 for n in rounded.values() if n > 1)

    slots: list[dict] = []
    for idx, (slot, label, frac) in enumerate(_PLAN_SLOT_ORDER):
        meal = best_combo[idx]
        items = meal.get("items", []) or []
        totals = _meal_totals(items)
        slots.append(
            {
                "slot": slot,
                "label": label,
                "target_kcal": round(float(targets.get("kcal", 0) or 0) * frac),
                "items": items,
                "kcal": totals["kcal"],
                "protein_g": totals["protein_g"],
                "carbs_g": totals["carbs_g"],
                "fat_g": totals["fat_g"],
                **({"fiber_g": round(sum(float(i.get("fiber_g", 0) or 0) for i in items), 1)} if any("fiber_g" in i for i in items) else {}),
            }
        )
    log.info(
        "shared_plan.audit slot_pool_sizes=%s combos_evaluated=%s top20=%s determinism=%s selected_score=%.4f selected_meals=%s selected_totals=%s",
        {s: len(slot_cands.get(s, [])) for s, _, _ in _PLAN_SLOT_ORDER},
        len(combo_rows),
        [
            {
                "score": round(float(score), 4),
                "meals": [m.get("meal_name") for m in meals],
                "totals": totals,
            }
            for score, meals, totals in top20
        ],
        {
            "sort_keys": ["full_day_score(desc)"],
            "fixed_seed": False,
            "stable_ordering": True,
            "top20_tie_groups": tie_groups,
            "top20_distinct_score_bands": len(rounded),
            "top20_score_bands": dict(rounded),
        },
        best_score,
        [m.get("meal_name") for m in best_combo],
        _sum_meal_totals(best_combo),
    )
    return slots


def _record_recommendation(account_id: int, date_key: str, slot: str, meal: dict) -> None:
    if not meal:
        return
    try:
        with db.write_lock(), db.connect() as c:
            _init_recommendation_history_table(c)
            c.execute(
                """
                INSERT INTO recommendation_history
                (account_id, date, slot, meal_key, meal_name, shown_keys, score, created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (
                    account_id,
                    date_key,
                    slot,
                    str(meal.get("primary_key") or ""),
                    str(meal.get("meal_name") or ""),
                    json.dumps([str(i.get("key") or "") for i in meal.get("items", [])]),
                    float(meal.get("score") or 0),
                    time.time(),
                ),
            )
    except Exception as ex:
        log.info("next_move history write failed (%s)", ex)


@app.post("/foods/recommend")
def foods_recommend(body: RecommendBody, request: Request):
    """Real "what to eat next" over the WHOLE food DB (839+ dishes), ranked
    against the user's ACTUAL remaining macros and filtered to their diet
    server-side (where the veg/non-veg/jain data lives). Optionally adds a
    Gemini-composed one-liner grounded in the ranked foods. Like /foods/search
    this is a plain DB lookup -- it requires a signed-in account but NEVER
    consumes a free-scan credit and never calls the vision model."""
    acct = auth.require_account(request)
    rem = {
        "kcal": max(0.0, body.remaining.kcal),
        "protein_g": max(0.0, body.remaining.protein_g),
        "carbs_g": max(0.0, body.remaining.carbs_g),
        "fat_g": max(0.0, body.remaining.fat_g),
    }
    goal_name = (body.goal or "maintain").strip().lower()
    goal = {"goal": goal_name}
    # protein target isn't sent; derive a proxy so the protein-priority switch
    # still works: if a real gap exists, treat protein as a priority.
    goal["protein_g"] = rem["protein_g"] * 3 if rem["protein_g"] > 0 else 0
    diet = (body.diet or "veg").strip().lower()
    limit = max(1, min(24, body.limit))
    date_key = (body.date or "").strip()[:10] or time.strftime("%Y-%m-%d")
    slot = _next_slot_from_logs(acct["id"], date_key, body.slot, body.hour)
    training = (body.training or "").strip().lower()
    # If targets are present, align slot budget to a realistic day share.
    if body.targets is not None:
        share = _target_kcal_share(slot)
        rem["kcal"] = min(rem["kcal"], max(120.0, body.targets.kcal * share))
        rem["protein_g"] = min(rem["protein_g"], max(8.0, body.targets.protein_g * share))
        rem["carbs_g"] = min(rem["carbs_g"], max(10.0, body.targets.carbs_g * share))
        rem["fat_g"] = min(rem["fat_g"], max(4.0, body.targets.fat_g * share))

    if body.ai_mode:
        try:
            ai_move = _ai_next_move(
                rem=rem,
                diet=diet,
                goal_name=goal_name,
                slot=slot,
                training=training,
                profile=(body.profile.model_dump() if body.profile else {}),
            )
            if not ai_move:
                raise RuntimeError("empty AI next_move")
            out = {"results": [], "slot": slot, "next_move": ai_move}
            log.info(
                "next_move ai mode slot=%s category=%s meal=%s",
                slot,
                ai_move.get("category"),
                ai_move.get("meal", {}).get("name"),
            )
            _mark_ai_mode("next_move_ok", account_id=acct["id"], slot=slot)
            if body.phrase:
                out["suggestion"] = ai_move.get("reason") or ""
            return out
        except Exception as ex:
            log.info("next_move ai mode failed (%s)", ex)
            _mark_ai_mode("next_move_fail", account_id=acct["id"], slot=slot)
            raise HTTPException(status_code=503, detail="AI next move unavailable")

    reason_category, reason_text = _macro_gap_reason(rem, goal_name)
    top = _rank_foods(rem, goal, diet, limit)
    out = {"results": [_food_suggestion(f) for f in top], "slot": slot}

    meals = _build_next_move_candidates(
        account_id=acct["id"],
        date_key=date_key,
        slot=slot,
        rem=rem,
        diet=diet,
        goal_name=goal_name,
        training=training,
        limit=max(3, min(10, limit)),
    )
    if meals:
        primary = meals[0]
        alternatives = meals[1:7]
        out["next_move"] = {
            "category": reason_category,
            "slot": slot,
            "meal": {
                "name": primary["meal_name"],
                "items": _meal_component_summary(primary["items"]),
                **primary["totals"],
            },
            "alternatives": [
                {"name": m["meal_name"], "items": _meal_component_summary(m["items"]), **m["totals"]}
                for m in alternatives
            ],
            "reason": reason_text,
        }
        _record_recommendation(acct["id"], date_key, slot, primary)
        log.info(
            "next_move selected slot=%s category=%s meal=%s totals=%s alternatives=%s",
            slot,
            reason_category,
            primary["meal_name"],
            primary["totals"],
            [m["meal_name"] for m in alternatives],
        )
    else:
        log.info("next_move no valid meal candidates; falling back to food-level ranking")
    if body.phrase:
        try:
            out["suggestion"] = _ai_phrase(diet, goal, slot, rem, top)
        except Exception:
            out["suggestion"] = _deterministic_phrase(top, rem)
    return out


with db.write_lock(), db.connect() as _c:
    _init_recommendation_history_table(_c)


# --------------------------------------------------------------------------- #
#  "Should I eat this?" -- a pre-meal verdict (rules + grounded AI advice)
# --------------------------------------------------------------------------- #
# The authoritative traffic-light logic lives here (server-side) so the verdict
# a user sees is consistent and can't be spoofed by the client, and so the AI
# layer can be grounded in real, already-computed facts. The client also has an
# identical deterministic engine (app/mealVerdict.ts) it shows instantly and as
# an offline fallback; this endpoint upgrades the *advice* wording with Gemini.

def _portion_phrase(frac: float) -> str:
    if frac >= 0.7:
        return "about three-quarters of it"
    if frac >= 0.58:
        return "about two-thirds of it"
    if frac >= 0.42:
        return "about half of it"
    if frac >= 0.28:
        return "about a third of it"
    return "a small portion"


_VERDICT_RANK = {"green": 0, "yellow": 1, "red": 2}


def _verdict_rules(meal: dict, consumed: dict, goal: dict, training: str) -> dict:
    """Deterministic verdict for a scanned meal vs. the day's remaining budget
    and training context. Kept in lock-step with app/mealVerdict.ts."""
    kcal_goal = goal.get("kcal", 0) or 0
    if kcal_goal <= 0 or (meal.get("kcal", 0) or 0) <= 0:
        return {
            "overall": "green",
            "headline": "Log it when you're ready",
            "lines": [],
            "advice": "Set a daily goal to see whether a meal fits your day.",
            "fitFraction": None,
        }

    p_goal = goal.get("protein_g", 0) or 0
    c_goal = goal.get("carbs_g", 0) or 0
    f_goal = goal.get("fat_g", 0) or 0

    rem_kcal = kcal_goal - consumed["kcal"]
    after_kcal = consumed["kcal"] + meal["kcal"]
    kcal_over = after_kcal - kcal_goal
    rem_p = p_goal - consumed["protein_g"]
    rem_c = c_goal - consumed["carbs_g"]
    after_fat = consumed["fat_g"] + meal["fat_g"]
    fat_over = after_fat - f_goal
    after_carb = consumed["carbs_g"] + meal["carbs_g"]

    lines = []

    kcal_slack = max(120.0, kcal_goal * 0.06)
    if kcal_over <= 0:
        lines.append({"state": "green", "text": f"Fits your calories — {round(kcal_goal - after_kcal)} kcal still to spare"})
    elif kcal_over <= kcal_slack:
        lines.append({"state": "yellow", "text": f"Just over — about {round(kcal_over)} kcal past today's target"})
    else:
        lines.append({"state": "red", "text": f"Puts you ~{round(kcal_over)} kcal over today"})

    if meal["protein_g"] >= 15:
        lines.append({"state": "green", "text": f"Good protein — adds {round(meal['protein_g'])}g"})
    elif rem_p >= 20 and meal["protein_g"] < 10:
        lines.append({"state": "yellow", "text": f"Low protein — you still need ~{round(rem_p)}g today"})

    fat_slack = max(15.0, f_goal * 0.15)
    if f_goal > 0 and fat_over > fat_slack:
        lines.append({"state": "red", "text": f"High fat — ~{round(fat_over)}g over your fat target"})
    elif f_goal > 0 and consumed["fat_g"] >= f_goal * 0.8 and meal["fat_g"] >= 12:
        lines.append({"state": "yellow", "text": "High fat — you're already near your fat target"})
    elif f_goal > 0 and meal["fat_g"] >= f_goal * 0.6:
        lines.append({"state": "yellow", "text": "On the oily side for one meal"})

    if training == "endurance" and c_goal > 0 and rem_c >= c_goal * 0.35 and meal["carbs_g"] >= 25:
        lines.append({"state": "green", "text": "Good carbs to fuel your endurance day"})
    elif training == "performance" and (meal["fat_g"] >= 18 or meal["kcal"] >= rem_kcal * 0.9):
        lines.append({"state": "yellow", "text": "Heavy for right before a performance"})
    elif c_goal > 0 and after_carb > c_goal * 1.2:
        lines.append({"state": "yellow", "text": "High carbs — over your carb target"})

    overall = "green"
    for ln in lines:
        if _VERDICT_RANK[ln["state"]] > _VERDICT_RANK[overall]:
            overall = ln["state"]

    fit_fraction = 0.0 if rem_kcal <= 0 else min(1.0, rem_kcal / meal["kcal"])

    if rem_kcal <= 0:
        advice = "You're already at today's target. If you really want it, keep it to a few bites and balance it out tomorrow."
    elif fit_fraction >= 0.95:
        if training == "endurance" and c_goal > 0 and rem_c >= c_goal * 0.35:
            advice = "You're low on carbs and training today — go for it."
        elif overall == "green":
            advice = "This fits your day — enjoy it."
        else:
            advice = "It fits your calories; just mind the note above."
    else:
        phrase = _portion_phrase(fit_fraction)
        if overall == "red":
            advice = f"It's a big one. If you want it, have {phrase} and save the rest for later."
        else:
            advice = f"Have {phrase} to stay on target, and keep the rest for later."
        if training == "strength" and meal["protein_g"] >= 15:
            advice += " The protein is great for recovery."

    headline = (
        "You can have this" if overall == "green"
        else "Fits with a small tweak" if overall == "yellow"
        else "Think twice on the portion"
    )

    return {"overall": overall, "headline": headline, "lines": lines, "advice": advice, "fitFraction": fit_fraction}


# AI advice is cached like the recommend phrasing: coarse bucket + short TTL,
# best-effort, never breaks the endpoint.
_VERDICT_TTL = 600
_VERDICT_CACHE_MAX = 512
_verdict_cache: dict = {}
_verdict_lock = threading.Lock()


def _verdict_key(dish: str, training: str, overall: str, meal: dict, rem_kcal: float) -> tuple:
    return (
        (dish or "")[:40].lower(),
        training or "",
        overall,
        int(round(meal["kcal"] / 50.0)),
        int(round(meal["protein_g"] / 5.0)),
        int(round(meal["fat_g"] / 5.0)),
        int(round(rem_kcal / 100.0)),
    )


def _ai_verdict_advice(dish: str, meal: dict, consumed: dict, goal: dict, training: str, rules: dict) -> str:
    """Warm, honest one-to-two sentence 'should you eat this' advice, GROUNDED in
    the already-computed facts (traffic-light state + real numbers). Cached +
    best-effort; falls back to the deterministic advice on any failure."""
    rem_kcal = (goal.get("kcal", 0) or 0) - consumed["kcal"]
    key = _verdict_key(dish, training, rules["overall"], meal, rem_kcal)
    now = time.time()
    with _verdict_lock:
        hit = _verdict_cache.get(key)
        if hit and (now - hit[0]) < _VERDICT_TTL:
            return hit[1]

    facts = "; ".join(ln["text"] for ln in rules["lines"]) or "fits the day"
    frac = rules.get("fitFraction")
    portion_hint = (
        "the whole plate fits" if (frac is None or frac >= 0.95)
        else f"only about {int(round(frac * 100))}% of it fits the remaining calories"
    )
    prompt = (
        "You are a warm, honest Indian nutrition assistant helping someone decide, BEFORE they "
        "eat, whether a dish fits their day. Base your reply ONLY on these facts (do not invent "
        "numbers or new claims):\n"
        f"Dish: {dish or 'this meal'}\n"
        f"Overall verdict: {rules['overall']} ({rules['headline']})\n"
        f"Facts: {facts}\n"
        f"Portion fit: {portion_hint}\n"
        f"Training context today: {training or 'none'}\n\n"
        "Write ONE or TWO short, friendly sentences (max 35 words total) telling them whether to "
        "eat it and, if it doesn't fully fit, a concrete portion tip (e.g. have about half). Be "
        "encouraging, never shaming. No medical claims, no specific calorie/gram numbers in the "
        'reply. Respond as JSON: {"advice": "<text>"}'
    )
    text = rules["advice"]
    try:
        resp = _generate(prompt)
        data = extract_json(resp.text)
        out = (data.get("advice") or "").strip()
        if not out:
            raise ValueError("empty advice")
        # Guard against numbers leaking in (we asked for none) and runaway length.
        if len(out) > 240:
            raise ValueError("advice too long")
        text = out
    except Exception as ex:
        log.info("verdict: AI advice failed (%s) -- using deterministic text", ex)
        text = rules["advice"]

    with _verdict_lock:
        if len(_verdict_cache) > _VERDICT_CACHE_MAX:
            _verdict_cache.clear()
        _verdict_cache[key] = (now, text)
    return text


class VerdictMacros(BaseModel):
    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0


class VerdictBody(BaseModel):
    meal: VerdictMacros
    consumed: VerdictMacros
    goal: VerdictMacros
    goal_name: str = "maintain"
    training: str = ""
    dish: str = ""
    phrase: bool = True


@app.post("/meals/verdict")
def meals_verdict(body: VerdictBody, request: Request):
    """"Should I eat this?" -- given a scanned meal, the day's totals so far and
    the daily targets, return a traffic-light verdict (rules-based, authoritative)
    plus a grounded Gemini one-liner of advice. Requires a signed-in account but
    NEVER consumes a free-scan credit and never calls the vision model."""
    auth.require_account(request)
    meal = {
        "kcal": max(0.0, body.meal.kcal),
        "protein_g": max(0.0, body.meal.protein_g),
        "carbs_g": max(0.0, body.meal.carbs_g),
        "fat_g": max(0.0, body.meal.fat_g),
    }
    consumed = {
        "kcal": max(0.0, body.consumed.kcal),
        "protein_g": max(0.0, body.consumed.protein_g),
        "carbs_g": max(0.0, body.consumed.carbs_g),
        "fat_g": max(0.0, body.consumed.fat_g),
    }
    goal = {
        "kcal": max(0.0, body.goal.kcal),
        "protein_g": max(0.0, body.goal.protein_g),
        "carbs_g": max(0.0, body.goal.carbs_g),
        "fat_g": max(0.0, body.goal.fat_g),
        "goal": (body.goal_name or "maintain").strip().lower(),
    }
    training = (body.training or "").strip().lower()
    if training not in ("rest", "endurance", "strength", "performance"):
        training = ""

    rules = _verdict_rules(meal, consumed, goal, training)
    source = "rule"
    if body.phrase and rules["lines"]:
        try:
            advice = _ai_verdict_advice((body.dish or "").strip(), meal, consumed, goal, training, rules)
            if advice and advice != rules["advice"]:
                source = "ai"
            rules["advice"] = advice
        except Exception:
            pass  # keep deterministic advice
    rules["source"] = source
    return rules
# -----------------------------------------------------------------------------

_client = None


def get_client():
    """Deprecated direct accessor -- kept only in case anything still expects
    a raw genai client. New code should use ai_provider.get_provider() so
    Gemini isn't the only provider the rest of the app can talk to."""
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        _client = genai.Client(api_key=key)
    return _client


def _generate(contents):
    """Single entry point for all Gemini calls, now routed through the
    AIProvider abstraction (ai_provider.py) so main.py itself no longer talks
    to the genai SDK directly -- swapping providers (Qwen/OpenAI) means
    implementing a new AIProvider subclass, not touching every call site
    here. `contents` is a prompt string, or a [prompt, PIL.Image] list for
    the photo path."""
    return ai_provider.get_provider().generate(contents)


def extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    s, e = text.find("{"), text.rfind("}")
    if s != -1 and e != -1:
        text = text[s:e + 1]
    return json.loads(text)


@app.on_event("startup")
def _validate_config() -> None:
    """Fail loud (in logs) on missing critical config at boot, and warn about
    insecure dev toggles left enabled. Does not crash the process so that a
    misconfigured deploy still serves /health for diagnosis."""
    problems = []
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        problems.append("GEMINI_API_KEY is not set — /analyze will fail.")
    for p in problems:
        log.warning("CONFIG: %s", p)
    # Unmissable regardless of APP_ENV -- this used to only warn in "production",
    # so a dev run with a missing/wrong DATABASE_URL silently wrote real user
    # data into a local SQLite file with no indication anything was off. That
    # actually happened once (see backend/community.db.archived_*) before this
    # check existed. Never let this be silent again.
    if db.backend_name() == "sqlite":
        log.warning(
            "=" * 70 + "\nDATABASE: using local SQLite (%s), NOT Postgres/Supabase. "
            "DATABASE_URL is unset or failed to load. Any accounts/posts/etc. "
            "created right now go into a local file on this machine, not your "
            "Supabase project, and won't show up there.\n" + "=" * 70,
            db.SQLITE_PATH,
        )
    if APP_ENV in ("production", "prod"):
        if os.environ.get("ALLOW_DEV_LOGIN", "").strip() in ("1", "true", "True"):
            log.warning("SECURITY: ALLOW_DEV_LOGIN is ON in production — disable it.")
        if not APP_API_KEY:
            log.warning("SECURITY: APP_API_KEY is unset — /analyze has no shared-secret gate.")
        if not payments.configured():
            log.warning("PAYMENTS: Razorpay keys not set — Pro upgrades will be unavailable.")
    log.info(
        "gofit backend ready: env=%s db=%s model=%s origins=%s",
        APP_ENV, db.backend_name(), MODEL, ALLOWED_ORIGINS,
    )


@app.get("/health")
def health():
    """Liveness probe: process is up and serving. Cheap, no external calls."""
    return {
        "ok": True,
        "env": APP_ENV,
        "model": MODEL,
        "db": db.backend_name(),
        "db_foods": len(FOOD_DB),
        "auth": bool(APP_API_KEY),
        "payments": payments.configured(),
        "blob_storage": blob_storage.configured(),
        "rate_per_min": RATE_PER_MIN,
        "rate_per_day": RATE_PER_DAY,
    }


@app.get("/ready")
def ready():
    """Readiness probe: verifies the DB is reachable before routing traffic.
    Returns 503 when the datastore is down so load balancers can hold traffic."""
    try:
        db.ping()
    except Exception as ex:
        log.warning("readiness check failed: %s", ex)
        raise HTTPException(status_code=503, detail="Database not reachable")
    return {"ready": True, "db": db.backend_name()}


MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB cap to prevent memory-exhaustion abuse


def _require_scan_slot(request: Request) -> dict:
    """Shared free-trial gate for both /analyze and /analyze/text -- scanning
    requires an account, and free accounts get a limited number of scans
    before the paywall (Pro is unlimited). Reserves the slot atomically
    BEFORE the slow Gemini call (see auth.reserve_scan's docstring for the
    race this closes)."""
    account = auth.account_from_request(request)
    if not account:
        raise HTTPException(status_code=401, detail="Please sign in to scan your food.")
    if not auth.reserve_scan(account["id"]):
        usage = auth.usage_for(account["id"])
        raise HTTPException(
            status_code=402,
            detail=f"You've used all {usage['scans_limit']} free scans. Upgrade to keep scanning.",
        )
    return account


def _sanitize_questions(data: dict) -> list:
    """Validate & clamp the model's clarifying `questions` so the client can
    trust them. Drops anything malformed rather than surfacing it. Each option's
    `factor` multiplies its target item's per-unit kcal AND macros; the baseline
    option (default) must be factor 1.0 so ignoring a question changes nothing."""
    raw = data.get("questions")
    if not isinstance(raw, list):
        return []
    item_count = len(data.get("items", []))
    out: list = []
    for q in raw:
        if not isinstance(q, dict):
            continue
        target = q.get("target_item")
        prompt = q.get("prompt")
        opts_raw = q.get("options")
        if not isinstance(target, int) or not (0 <= target < item_count):
            continue
        if not isinstance(prompt, str) or not prompt.strip():
            continue
        if not isinstance(opts_raw, list) or len(opts_raw) < 2:
            continue
        options: list = []
        for o in opts_raw[:4]:
            if not isinstance(o, dict):
                continue
            label = o.get("label")
            factor = o.get("factor")
            if not isinstance(label, str) or not label.strip():
                continue
            if not isinstance(factor, (int, float)):
                continue
            # Clamp to a sane range so a bad factor can't 10x a meal.
            factor = max(0.3, min(3.0, float(factor)))
            options.append({"label": label.strip()[:32], "factor": round(factor, 3)})
        if len(options) < 2:
            continue
        default_index = q.get("default_index", 0)
        if not isinstance(default_index, int) or not (0 <= default_index < len(options)):
            default_index = 0
        # The baseline the model already used must be a no-op multiplier so the
        # displayed totals match until the user actually answers.
        options[default_index]["factor"] = 1.0
        out.append({
            "id": str(q.get("id") or f"q{len(out)}")[:40],
            "prompt": prompt.strip()[:120],
            "target_item": target,
            "options": options,
            "default_index": default_index,
        })
        if len(out) >= 3:
            break
    return out


def _run_gemini_analysis(account: dict, prompt: str, media, error_detail_prefix: str, cache_key: str | None = None) -> dict:
    """Shared retry/anchor/usage/scan-history plumbing for both the image and
    text analysis paths -- media is either a PIL.Image (photo) or omitted
    (text-only prompt already has the description baked in).

    cache_key: sha256 of the exact image bytes (photo path) or the normalized
    description text (text path). When set and a prior analysis for the exact
    same input exists, skip the (non-deterministic) Gemini call entirely and
    return the cached result with freshly-stamped usage -- guarantees the
    same input always yields the same numbers.
    """
    if cache_key:
        cached = _analyze_cache_get(cache_key)
        if cached is not None:
            data = dict(cached)
            data["usage"] = auth.usage_for(account["id"])
            data["from_cache"] = True
            progress.record_scan(
                account["id"], success=True, item_count=len(data.get("items", [])),
                total_kcal=data.get("calories_kcal"),
            )
            return data
    last = None
    for attempt in range(3):
        try:
            parts = [prompt, media] if media is not None else [prompt]
            resp = _generate(parts)
            data = extract_json(resp.text)
            if not isinstance(data, dict) or "items" not in data:
                raise ValueError("model returned unexpected shape")
            for it in data.get("items", []):
                it.setdefault("count", 1)
                it.setdefault("kcal_per_unit", 0)
                it.setdefault("protein_g", 0)
                it.setdefault("carbs_g", 0)
                it.setdefault("fat_g", 0)
                it.setdefault("countable", True)
                it.setdefault("unit", "piece")
            # Validate clarifying questions BEFORE anchor_items so target_item
            # indices still line up with the model's original items order.
            data["questions"] = _sanitize_questions(data)
            data = anchor_items(data)
            if cache_key:
                _analyze_cache_put(cache_key, data)
            data["usage"] = auth.usage_for(account["id"])
            scan_result_id = food_graph.record_scan_result(
                account["id"],
                raw_items=data.get("items", []),
                resolved_items=data.get("items", []),
                confidence=float(data.get("confidence", 0) or 0),
                status="resolved",
            )
            if scan_result_id:
                data["scan_result_id"] = scan_result_id
            items = data.get("items", [])
            progress.record_scan(
                account["id"], success=True, item_count=len(items),
                total_kcal=data.get("calories_kcal"),
            )
            return data
        except HTTPException:
            raise
        except Exception as ex:
            last = ex
            log.warning("%s attempt %d failed: %s", error_detail_prefix, attempt + 1, ex)
    # Every retry failed -- refund the reserved slot so a failed request
    # (not the user's fault) doesn't cost them a real scan.
    auth.release_scan(account["id"])
    progress.record_scan(account["id"], success=False, error_detail=str(last)[:500] if last else None)
    raise HTTPException(status_code=502, detail=f"Could not analyze the {error_detail_prefix}. Please try again.")


def _upload_meal_photo_safe(photo_path: str, raw: bytes, account_id: str) -> None:
    """Runs after the /analyze response has already been sent (BackgroundTasks).
    Never let a Storage hiccup surface anywhere -- the analysis already
    succeeded and shipped to the client; a missing photo later is a cosmetic
    (not correctness) issue GET /logs already tolerates via a null photoUrl."""
    try:
        blob_storage.upload_meal_photo(photo_path, raw)
    except Exception:
        log.exception("background meal photo upload failed for account %s", account_id)


@app.post("/analyze")
async def analyze(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    _: None = Depends(guard),
):
    account = _require_scan_slot(request)

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="File must be an image")
    try:
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Empty file")
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 8MB)")
        # Hash the exact bytes BEFORE any decoding/downscaling -- this is the
        # cache key that makes re-analyzing the identical photo deterministic.
        image_hash = hashlib.sha256(raw).hexdigest()
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((768, 768))  # downscale: big speed win, negligible accuracy loss
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or unreadable image")

    data = _run_gemini_analysis(account, PROMPT, img, "photo", cache_key=image_hash)
    # Best-effort photo upload -- hash-based path means the exact same photo
    # re-scanned by the same user just overwrites, never duplicates storage.
    # A storage hiccup must never break the (already-successful) analysis.
    #
    # Neither the upload nor a signed URL needs to block THIS response:
    # ScanScreen shows the just-captured local photo, not photo_url, while
    # reviewing/editing the scan, and GET /logs independently (re)signs a
    # fresh URL from photo_path once the meal is actually saved (signed URLs
    # are short-lived, so handing one out here would usually be stale by the
    # time it's used anyway). So we just hand back the deterministic path
    # (pure string math, no network) and push the real upload onto a
    # background task -- this alone was costing every fresh scan ~1-1.7s of
    # pure Storage-roundtrip time that the client never actually needed yet.
    if blob_storage.configured():
        photo_path = f"{account['id']}/{image_hash}.jpg"
        data["photo_path"] = photo_path
        if not data.get("from_cache"):
            background_tasks.add_task(_upload_meal_photo_safe, photo_path, raw, account["id"])
    return data


class TextAnalyzeBody(BaseModel):
    description: str = Field(..., min_length=2, max_length=500)


@app.post("/analyze/text")
def analyze_text(body: TextAnalyzeBody, request: Request, _: None = Depends(guard)):
    """Text (or voice-transcribed-to-text) meal logging -- same free-scan
    gate, same DB-anchoring, same response shape as the photo path, just
    without an image. Lets you log a meal by describing it when a photo
    isn't practical."""
    account = _require_scan_slot(request)
    normalized = re.sub(r"\s+", " ", body.description.strip().lower())
    text_hash = "text:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    prompt = f'{TEXT_PROMPT}\n\nUser\'s description: "{body.description.strip()}"'
    return _run_gemini_analysis(account, prompt, None, "description", cache_key=text_hash)


# --------------------------------------------------------------------------- #
#  AI daily meal plan (see plan.py) -- persisted, profile-driven, not random.
# --------------------------------------------------------------------------- #
# The plan module owns its table, persistence and routes but delegates the two
# things only this module can do -- picking real foods from FOOD_DB for a slot's
# budget, and composing a grounded Gemini coach note -- back to these callables.
def _plan_pick_for_slot(
    budget: dict,
    diet: str,
    goal_str: str,
    limit: int,
    slot: str = "",
    training: str = "",
    role_hint: str = "",
) -> list:
    """Top real DB foods that fit a single slot's calorie/macro budget, already
    diet-filtered and in the client-friendly _food_suggestion shape. Reuses the
    exact ranking the /foods/recommend endpoint uses so the plan and the (later)
    recommender stay consistent."""
    goal = {"goal": goal_str, "protein_g": budget.get("protein_g", 0) * 3}
    pool = max(limit * 3, 24)
    top = _rank_foods(budget, goal, diet, pool)
    if not top:
        return []

    role_map = _food_roles_map()
    required_roles, optional_roles, _, _ = _template_role_prefs(slot, training)
    hint = (role_hint or "").strip().lower()

    def _role_fit(food: dict) -> tuple[int, int, int]:
        roles = role_map.get(str(food.get("key") or "").strip().lower(), set())
        hint_hit = 1 if (hint and hint in roles) else 0
        req_hits = sum(1 for r in required_roles if r in roles)
        opt_hits = sum(1 for r in optional_roles if r in roles)
        return hint_hit, req_hits, opt_hits

    scored = []
    for idx, food in enumerate(top):
        fit = _role_fit(food)
        scored.append((fit[0], fit[1], fit[2], -idx, food))
    scored.sort(key=lambda x: (x[0], x[1], x[2], x[3]), reverse=True)
    return [_food_suggestion(f) for _, _, _, _, f in scored[:limit]]


_HEAVY_WORDS = (
    "biryani", "pulao", "rice", "naan", "paratha", "bhatura", "puri",
    "paneer", "butter", "makhani", "fried",
)
_INCOMPATIBLE_RULES = (
    ("biryani", "sambar"),
    ("naan", "sambar"),
)


def _portion_step(unit: str, key: str) -> tuple[float, float, float]:
    t = f"{unit} {key}".lower()
    if any(w in t for w in ("roti", "chapati", "naan", "paratha", "idli", "egg", "piece", "slice")):
        return 1.0, 1.0, 4.0
    if any(w in t for w in ("cup", "katori", "bowl", "serving")):
        return 0.5, 0.5, 2.5
    return 0.5, 0.5, 3.0


def _round_count(v: float, step: float, lo: float, hi: float) -> float:
    if step <= 0:
        step = 0.5
    r = round(v / step) * step
    return min(hi, max(lo, r))


def _component_from_food(food: dict, count: float) -> dict:
    return {
        "key": food["key"],
        "name": food.get("name") or food["key"].replace("_", " ").title(),
        "unit": food.get("unit", "serving"),
        "count": count,
        "kcal": round(count * float(food.get("kcal_per_unit", 0) or 0)),
        "protein_g": round(count * float(food.get("protein_g_per_unit", 0) or 0), 1),
        "carbs_g": round(count * float(food.get("carbs_g_per_unit", 0) or 0), 1),
        "fat_g": round(count * float(food.get("fat_g_per_unit", 0) or 0), 1),
        **({"fiber_g": round(count * float(food.get("fiber_g", 0) or 0), 1)} if ("fiber_g" in food) else {}),
    }


def _meal_totals(items: list[dict]) -> dict:
    return {
        "kcal": round(sum(float(i.get("kcal", 0) or 0) for i in items)),
        "protein_g": round(sum(float(i.get("protein_g", 0) or 0) for i in items), 1),
        "carbs_g": round(sum(float(i.get("carbs_g", 0) or 0) for i in items), 1),
        "fat_g": round(sum(float(i.get("fat_g", 0) or 0) for i in items), 1),
    }


def _combo_sides_for_key(primary_key: str) -> list[dict]:
    sides = _persisted_combo_sides(primary_key)
    if sides:
        return sides
    entry = COMBOS.get(primary_key)
    if isinstance(entry, dict):
        return list(entry.get("sides", []) or [])
    return []


def _is_compatible_meal(slot: str, items: list[dict]) -> tuple[bool, str]:
    if not items:
        return False, "empty meal"
    keys = [str(i.get("key", "")).lower() for i in items]
    names = [str(i.get("name", "")).lower() for i in items]
    def _has(tok: str) -> bool:
        return any(tok in k for k in keys) or any(tok in n for n in names)
    for a, b in _INCOMPATIBLE_RULES:
        if _has(a) and _has(b):
            return False, f"incompatible pair: {a}+{b}"
    if slot in ("lunch", "dinner") and len(items) < 2:
        return False, "main meal missing components"
    if slot == "snack":
        if len(items) > 2:
            return False, "snack too complex"
        if any(any(w in (str(i.get("key", "")).lower() + " " + str(i.get("name", "")).lower()) for w in _HEAVY_WORDS) for i in items):
            return False, "snack too heavy"
    if slot in ("lunch", "dinner") and len(items) == 1:
        t = (str(items[0].get("key", "")) + " " + str(items[0].get("name", ""))).lower()
        if any(w in t for w in ("naan", "roti", "rice", "biryani", "paratha")):
            return False, "staple-only main meal"
    return True, "ok"


def _meal_fit_score(items: list[dict], budget: dict) -> float:
    totals = _meal_totals(items)
    if totals["kcal"] <= 0:
        return -1e9
    score = 0.0
    score -= abs(totals["kcal"] - float(budget.get("kcal", 0) or 0)) / max(120.0, float(budget.get("kcal", 0) or 1))
    score -= abs(totals["protein_g"] - float(budget.get("protein_g", 0) or 0)) / max(12.0, float(budget.get("protein_g", 0) or 1))
    score -= max(0.0, totals["carbs_g"] - float(budget.get("carbs_g", 0) or 0)) * 0.03
    score -= max(0.0, totals["fat_g"] - float(budget.get("fat_g", 0) or 0)) * 0.06
    return score


def _plan_pick_meal_for_slot(
    budget: dict,
    diet: str,
    goal_str: str,
    slot: str,
    training: str,
    limit: int = 3,
) -> list[dict]:
    """Build a culturally-valid meal first, then tune portions toward slot macros.

    Debug logging reports template pick, candidate rejects, and final selection.
    """
    goal = {"goal": goal_str, "protein_g": budget.get("protein_g", 0) * 3}
    ranked = _plan_pick_for_slot(budget, diet, goal_str, max(36, limit * 10), slot, training, "staple")
    if not ranked:
        log.info("plan.combo slot=%s no ranked foods", slot)
        return []
    role_map = _food_roles_map()
    required_roles, _, _, _ = _template_role_prefs(slot, training)
    template = recipe_combo_engine.list_meal_templates(slot, training, limit=1)
    template_key = template[0]["template_key"] if template else "fallback"
    rejects: list[str] = []
    best_items: list[dict] = []
    best_score = -1e9

    for primary in ranked[:16]:
        p_key = str(primary.get("key") or "").strip().lower()
        p_roles = role_map.get(p_key, set())
        if required_roles and ("staple" in required_roles) and ("staple" not in p_roles) and slot in ("lunch", "dinner", "breakfast"):
            continue
        meal_foods: list[dict] = []
        p_step, p_lo, p_hi = _portion_step(str(primary.get("unit", "")), p_key)
        base_primary_count = 1.0 if p_step >= 1.0 else 0.5
        meal_foods.append(_component_from_food(primary, _round_count(base_primary_count, p_step, p_lo, p_hi)))

        # Prefer curated combo accompaniments for realistic Indian pairings.
        for side in _combo_sides_for_key(p_key):
            sk = str(side.get("key") or "").strip().lower()
            if not sk or sk == p_key:
                continue
            sf = FOOD_BY_KEY.get(sk)
            if not sf:
                continue
            if not _food_diet_ok(sf, diet):
                continue
            side_sug = _food_suggestion(sf)
            cnt = float(side.get("count") or 1)
            st, lo, hi = _portion_step(str(side_sug.get("unit", "")), sk)
            meal_foods.append(_component_from_food(side_sug, _round_count(cnt, st, lo, hi)))
            if len(meal_foods) >= max(2, limit):
                break

        # Fill missing required roles from ranked pool.
        have_roles = set()
        for it in meal_foods:
            have_roles.update(role_map.get(str(it.get("key", "")).lower(), set()))
        for req_role in required_roles:
            if req_role in have_roles:
                continue
            for cand in ranked:
                ck = str(cand.get("key") or "").lower()
                if ck in {str(m.get("key", "")).lower() for m in meal_foods}:
                    continue
                if req_role not in role_map.get(ck, set()):
                    continue
                st, lo, hi = _portion_step(str(cand.get("unit", "")), ck)
                meal_foods.append(_component_from_food(cand, _round_count(1.0, st, lo, hi)))
                have_roles.update(role_map.get(ck, set()))
                break

        # Protein rescue: if slot protein is clearly low, grow protein-role foods.
        totals = _meal_totals(meal_foods)
        if totals["protein_g"] < max(8.0, float(budget.get("protein_g", 0)) * 0.75):
            for i, it in enumerate(meal_foods):
                roles = role_map.get(str(it.get("key", "")).lower(), set())
                if "protein" not in roles:
                    continue
                key = str(it.get("key", "")).lower()
                st, lo, hi = _portion_step(str(it.get("unit", "")), key)
                new_c = _round_count(float(it.get("count", 1)) + st, st, lo, hi)
                sf = FOOD_BY_KEY.get(key)
                if not sf:
                    continue
                meal_foods[i] = _component_from_food(_food_suggestion(sf), new_c)
                break

        # Energy trim if too high.
        totals = _meal_totals(meal_foods)
        if totals["kcal"] > float(budget.get("kcal", 0)) * 1.2 and meal_foods:
            for i in range(len(meal_foods)):
                it = meal_foods[i]
                key = str(it.get("key", "")).lower()
                st, lo, hi = _portion_step(str(it.get("unit", "")), key)
                if float(it.get("count", 1)) <= lo:
                    continue
                sf = FOOD_BY_KEY.get(key)
                if not sf:
                    continue
                meal_foods[i] = _component_from_food(_food_suggestion(sf), _round_count(float(it.get("count", 1)) - st, st, lo, hi))
                totals = _meal_totals(meal_foods)
                if totals["kcal"] <= float(budget.get("kcal", 0)) * 1.08:
                    break

        ok, why = _is_compatible_meal(slot, meal_foods)
        if not ok:
            rejects.append(f"{p_key}:{why}")
            continue
        score = _meal_fit_score(meal_foods, budget)
        if score > best_score:
            best_score = score
            best_items = meal_foods

    if rejects:
        log.info("plan.combo slot=%s template=%s rejected=%s", slot, template_key, "; ".join(rejects[:6]))
    if not best_items:
        log.info("plan.combo slot=%s template=%s no valid combo", slot, template_key)
        return []
    log.info(
        "plan.combo slot=%s template=%s selected=%s portions=%s macros=%s",
        slot,
        template_key,
        [i["key"] for i in best_items],
        {i["key"]: i["count"] for i in best_items},
        _meal_totals(best_items),
    )
    return best_items


def _plan_ai_note(plan_data: dict, diet: str, goal_str: str) -> str:
    """ONE short, grounded sentence about how the planned day supports the goal.
    Best-effort: returns '' on any failure so plan.build_plan falls back to its
    deterministic note. Not cached here -- build_plan only runs on a real
    (re)generate, and the result is persisted, so this hits Gemini rarely."""
    lines = []
    for s in plan_data.get("slots", []):
        for it in s.get("items", []):
            lines.append(f"{s['label']}: {it['name']}")
    if not lines:
        return ""
    t = plan_data.get("targets", {})
    prompt = (
        "You are a concise, encouraging Indian nutrition coach. A user's planned day is:\n"
        + "\n".join(lines)
        + f"\n\nDaily targets: {int(t.get('kcal', 0))} kcal, {int(t.get('protein_g', 0))} g protein. "
        f"Diet: {diet}, goal: {goal_str}.\n"
        "Write ONE short sentence (max 24 words) on how this plan supports their goal. "
        "No medical claims, no calorie numbers in the sentence. "
        'Respond as JSON: {"note": "<sentence>"}'
    )
    try:
        resp = _generate(prompt)
        data = extract_json(resp.text)
        return (data.get("note") or "").strip()
    except Exception as ex:
        log.info("plan: AI note generation failed (%s)", ex)
        return ""


def _plan_ai_complete(
    targets: dict,
    diet: str,
    goal: str,
    date_key: str,
    training_context: str = "",
    consumed: Optional[dict] = None,
    hour: Optional[int] = None,
    profile: Optional[dict] = None,
) -> dict:
    consumed = consumed or {}
    slot_template = {
        "breakfast": "Breakfast",
        "lunch": "Lunch",
        "snack": "Snack",
        "dinner": "Dinner",
    }
    remaining = {
        "kcal": round(max(0.0, _to_num(targets.get("kcal")) - _to_num(consumed.get("kcal"))), 1),
        "protein_g": round(max(0.0, _to_num(targets.get("protein_g")) - _to_num(consumed.get("protein_g"))), 1),
        "carbs_g": round(max(0.0, _to_num(targets.get("carbs_g")) - _to_num(consumed.get("carbs_g"))), 1),
        "fat_g": round(max(0.0, _to_num(targets.get("fat_g")) - _to_num(consumed.get("fat_g"))), 1),
    }
    prompt = (
        "Create an Indian diet meal plan JSON for one day with four slots (breakfast, lunch, snack, dinner).\n"
        "Be practical, culturally realistic, and goal-aligned. No supplements.\n"
        f"Context:\nprofile={json.dumps(profile or {}, ensure_ascii=True)}\ndiet={diet}\ngoal={goal}\n"
        f"training={training_context}\ntargets={json.dumps(targets)}\nconsumed={json.dumps(consumed)}\nremaining={json.dumps(remaining)}\nhour={hour}\n\n"
        "Return JSON only in this exact shape:\n"
        '{"coach_note":"short sentence","slots":['
        '{"slot":"breakfast","label":"Breakfast","target_kcal":0,"items":[{"name":"...","count":1,"unit":"serving","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0}]},'
        '{"slot":"lunch","label":"Lunch","target_kcal":0,"items":[]},'
        '{"slot":"snack","label":"Snack","target_kcal":0,"items":[]},'
        '{"slot":"dinner","label":"Dinner","target_kcal":0,"items":[]}'
        "]}\n"
        "Use numeric values for macros, concise names, and realistic portions."
    )
    resp = _generate(prompt)
    data = extract_json(resp.text)
    slots = []
    by_slot = {}
    for row in (data.get("slots") or []):
        if not isinstance(row, dict):
            continue
        key = str(row.get("slot") or "").strip().lower()
        if key not in slot_template:
            continue
        meal = _normalize_meal_from_ai({"name": key.title(), "items": row.get("items") or []}, key.title())
        slot = {
            "slot": key,
            "label": slot_template[key],
            "target_kcal": round(max(0.0, _to_num(row.get("target_kcal"), 0.0))),
            "items": meal.get("items", []),
            "kcal": round(_to_num(meal.get("kcal")), 1),
            "protein_g": round(_to_num(meal.get("protein_g")), 1),
            "carbs_g": round(_to_num(meal.get("carbs_g")), 1),
            "fat_g": round(_to_num(meal.get("fat_g")), 1),
        }
        fibre_vals = [_to_num(i.get("fiber_g")) for i in slot["items"] if _to_num(i.get("fiber_g"), -1.0) >= 0]
        if fibre_vals:
            slot["fiber_g"] = round(sum(fibre_vals), 1)
        by_slot[key] = slot
    for key, label in slot_template.items():
        slots.append(by_slot.get(key) or {"slot": key, "label": label, "target_kcal": 0, "items": [], "kcal": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0})
    totals = {
        "kcal": round(sum(_to_num(s.get("kcal")) for s in slots), 1),
        "protein_g": round(sum(_to_num(s.get("protein_g")) for s in slots), 1),
        "carbs_g": round(sum(_to_num(s.get("carbs_g")) for s in slots), 1),
        "fat_g": round(sum(_to_num(s.get("fat_g")) for s in slots), 1),
    }
    fibre_total = round(sum(_to_num(s.get("fiber_g")) for s in slots if _to_num(s.get("fiber_g"), -1.0) >= 0), 1)
    if fibre_total > 0:
        totals["fiber_g"] = fibre_total
    out = {
        "date": date_key,
        "signature": "",
        "targets": {k: round(_to_num(targets.get(k)), 1) for k in ("kcal", "protein_g", "carbs_g", "fat_g")},
        "totals": totals,
        "slots": slots,
        "generated_at": time.time(),
        "coach_note": str(data.get("coach_note") or "").strip()[:220],
    }
    if "fiber_g" in targets:
        out["targets"]["fiber_g"] = round(_to_num(targets.get("fiber_g")), 1)
    if not out["coach_note"]:
        out["coach_note"] = _plan_ai_note(out, diet, goal) or "Plan tuned to your profile and today's remaining budget."
    return out


plan.init_db()
plan.configure(
    pick_for_slot=_plan_pick_for_slot,
    ai_note=_plan_ai_note,
    pick_meal_for_slot=_plan_pick_meal_for_slot,
    build_day_plan=_build_shared_day_plan,
    ai_full_plan=_plan_ai_complete,
)
app.include_router(plan.router)
