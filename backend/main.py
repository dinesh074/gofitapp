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
import re
import time
import hashlib
import logging
import threading
from collections import defaultdict, deque

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
import nutrition_api
import nutrition_engine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gofit")

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

# Packaged-food barcode lookup (POST /analyze/barcode) -- a deterministic
# OpenFoodFacts lookup, NOT a Gemini call, so it does NOT consume a free-scan
# credit (see barcode.py's module docstring).
app.include_router(barcode.router)

# Water + habit tracking (GET/POST /water, /habits) -- plain data entry, no AI,
# no scan credit involvement.
wellness.init_db()
app.include_router(wellness.router)

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

# Read-only Food Intelligence Graph API (nutri_* tables) -- Month 1 of
# GOFIT_MASTER_ARCHITECTURE_PROMPT.txt's roadmap. Separate from the existing
# /foods/* endpoints above, which still serve the live scanner's `foods`
# table; both exist side by side until the Month 4 scanner migration.
app.include_router(nutrition_api.router)

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
        ))
    c.executemany(
        """INSERT OR IGNORE INTO foods
           (key, unit, kcal_per_unit, protein_g, carbs_g, fat_g, fiber_g, sugar_g,
            sodium_mg, potassium_mg, calcium_mg, iron_mg, health_score,
            benefits_json, watch_outs_json, micros_json, aliases_json,
            source_name, source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    return len(rows)


def _row_to_food(r) -> dict:
    d = {
        "key": r["key"], "unit": r["unit"], "kcal_per_unit": r["kcal_per_unit"],
        "protein_g": r["protein_g"], "carbs_g": r["carbs_g"], "fat_g": r["fat_g"],
    }
    for col in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg", "health_score",
                "jain_status", "sattvic_status"):
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


def _load_nutri_food_db() -> list:
    """Real Food Intelligence Graph foods, shaped like a FOOD_DB record so
    /foods/recommend can rank over the same real, ingredient-aware,
    provenance-tracked data /foods/search now uses -- instead of the old
    `foods` table. vegetarian/vegan/eggetarian come straight from the
    backfilled nutri_foods columns (real recipe-ingredient classification,
    see dietary_rules.py), NOT re-derived from name-word matching here.
    Loaded once at startup (same pattern as FOOD_DB) since it backs every
    /foods/recommend call and a per-request N+1 nutrient fetch over ~1,347
    foods would be too slow."""
    try:
        with db.connect() as c:
            foods = c.execute(
                "SELECT food_id, canonical_name, vegetarian, vegan, eggetarian FROM nutri_foods"
            ).fetchall()
            nutrients = c.execute(
                """
                SELECT food_id, nutrient_code, amount FROM nutri_food_nutrients
                WHERE nutrient_code IN ('energy_kcal','protein_g','carb_g','fat_g')
                """
            ).fetchall()
            aliases = c.execute("SELECT food_id, alias FROM nutri_food_aliases").fetchall()
    except Exception as ex:
        log.warning("Could not load nutri_foods for /foods/recommend (%s) -- falling back to FOOD_DB only.", ex)
        return []
    nutrient_map: dict = {}
    for n in nutrients:
        nutrient_map.setdefault(n["food_id"], {})[n["nutrient_code"]] = n["amount"]
    alias_map: dict = {}
    for a in aliases:
        alias_map.setdefault(a["food_id"], []).append(a["alias"])
    out = []
    for f in foods:
        nm = nutrient_map.get(f["food_id"], {})
        kcal = nm.get("energy_kcal")
        if kcal is None:
            continue  # no real energy value -- never guess a serving's calories
        entry = {
            "key": f["food_id"],
            "name": f["canonical_name"],
            "unit": "100g",
            "kcal_per_unit": float(kcal),
            "protein_g": float(nm["protein_g"]) if nm.get("protein_g") is not None else 0.0,
            "carbs_g": float(nm["carb_g"]) if nm.get("carb_g") is not None else 0.0,
            "fat_g": float(nm["fat_g"]) if nm.get("fat_g") is not None else 0.0,
            "vegetarian": f["vegetarian"],
            "vegan": f["vegan"],
            "eggetarian": f["eggetarian"],
            "aliases": alias_map.get(f["food_id"], []),
            "_source": "nutri_foods",
            "_source_name": f["canonical_name"],
        }
        entry["_aliases"] = [a.lower().strip() for a in entry["aliases"]]
        out.append(entry)
    return out


NUTRI_FOOD_DB = _load_nutri_food_db()


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
    best = None
    best_len = 0
    for food in FOOD_DB:
        for alias in food["_aliases"]:
            if re.search(r"\b" + re.escape(alias) + r"\b", n) and len(alias) > best_len:
                best, best_len = food, len(alias)
    return best



def anchor_items(data: dict) -> dict:
    """Override per-unit calories AND macros with DB values when matched, then
    compute per-item and meal-level totals.

    v2: also carries through the extended DB fields where present --
    micronutrients (fiber/sugar/sodium/potassium/calcium/iron) scale with
    count just like the macros; health_score/benefits/watch_outs describe the
    food itself and are copied as-is (a "high in sodium" tag doesn't change
    because you ate two servings, so these are not multiplied by count).

    v3: unmatched items (source="ai") now also carry a micronutrient panel --
    the model's own per-unit ESTIMATE (see PROMPT's micros_estimate field),
    clamped to sane per-serving bounds so a hallucinated number can't blow up
    a day's micro totals. Tagged micros_source="ai_estimated" so the client
    can honestly label it differently from a verified DB match
    (micros_source="db") -- see micros.ts / MealDetailScreen.tsx. Every
    unmatched item is also logged to food_review.record_unmatched() so real
    scan volume (not guesswork) drives what gets curated into the verified
    DB next."""
    macros = ("protein_g", "carbs_g", "fat_g")
    micro_fields = ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg")
    # Per-unit sanity ceiling for an AI-estimated micro value -- guards against
    # a hallucinated number (e.g. "5000mg sodium in one idli") dominating a
    # day's totals. DB-matched values are real lab/govt data and are NOT
    # clamped (see the `food` branch below).
    _EST_CAPS = {
        "fiber_g": 25, "iron_mg": 20, "calcium_mg": 800,
        "potassium_mg": 2000, "vitamin_c_mg": 300, "sodium_mg": 3000, "sugar_g": 100,
    }
    for it in data.get("items", []):
        food = match_food(it.get("item", ""))
        if food:
            it["kcal_per_unit"] = food["kcal_per_unit"]
            for m in macros:
                it[m + "_per_unit"] = food.get(m, 0)
            for m in micro_fields:
                if m in food:
                    it[m + "_per_unit"] = food[m]
            it["unit"] = food.get("unit", it.get("unit", "piece"))
            it["source"] = "db"
            # Descriptive, not scaled by count -- see docstring.
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
            # Full vitamin/mineral panel ("all the minute details"), per-unit.
            if food.get("micros"):
                it["micros_per_unit"] = food["micros"]
                it["micros_source"] = "db"
        else:
            # fall back to the model's own per-unit macro estimates
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
            food_review.record_unmatched(it.get("item", ""), it)
        count = it.get("count", 1)
        it["kcal_total"] = round(count * it.get("kcal_per_unit", 0))
        for m in macros:
            it[m] = round(count * it.get(m + "_per_unit", 0), 1)
        for m in micro_fields:
            if (m + "_per_unit") in it:
                it[m] = round(count * it[m + "_per_unit"], 1)
        if "micros_per_unit" in it:
            it["micros"] = {k: round(v * count, 4) for k, v in it["micros_per_unit"].items()}

    items = data.get("items", [])
    data["calories_kcal"] = sum(it["kcal_total"] for it in items)
    totals = {
        "kcal": data["calories_kcal"],
        "protein_g": round(sum(it.get("protein_g", 0) for it in items), 1),
        "carbs_g": round(sum(it.get("carbs_g", 0) for it in items), 1),
        "fat_g": round(sum(it.get("fat_g", 0) for it in items), 1),
    }
    for m in micro_fields:
        vals = [it[m] for it in items if m in it]
        if vals:
            totals[m] = round(sum(vals), 1)
    micro_totals: dict = {}
    any_estimated = False
    for it in items:
        for k, v in it.get("micros", {}).items():
            micro_totals[k] = micro_totals.get(k, 0) + v
        if it.get("micros_source") == "ai_estimated":
            any_estimated = True
    if micro_totals:
        totals["micros"] = {k: round(v, 4) for k, v in micro_totals.items()}
        # True when ANY contributing item's micros came from the AI's own
        # estimate rather than a verified DB match -- lets the client show an
        # honest "Estimated" badge on the whole meal's micro panel instead of
        # silently mixing verified + guessed numbers with no distinction.
        totals["micros_estimated"] = any_estimated
    data["totals"] = totals
    return data

def _food_suggestion(food: dict) -> dict:
    """Map a FOOD_DB (or NUTRI_FOOD_DB) record to the shape the client turns
    into a FoodItem. DB macros are already per-unit. Prefers the food's real
    name field (NUTRI_FOOD_DB) over mangling the key, which is only a
    readable fallback for the old FOOD_DB's underscored keys."""
    out = {
        "key": food["key"],
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


_NUTRI_NUTRIENT_MAP = {
    "energy_kcal": "kcal_per_unit",
    "protein_g": "protein_g_per_unit",
    "carb_g": "carbs_g_per_unit",
    "fat_g": "fat_g_per_unit",
    "fibre_g": "fiber_g",
    "freesugar_g": "sugar_g",
    "sodium_mg": "sodium_mg",
    "potassium_mg": "potassium_mg",
    "calcium_mg": "calcium_mg",
    "iron_mg": "iron_mg",
}


def _nutri_food_suggestions_batch(scored_ids: list[tuple[str, str]]) -> list[dict]:
    """Batched version of _nutri_food_suggestion() for the whole result page
    in TWO queries total (nutrients + food flags), not two queries PER
    result. See nutrition_engine.get_foods_nutrients_bulk/get_foods_bulk."""
    food_ids = [fid for fid, _ in scored_ids]
    foods_by_id, nutrients_by_food = nutrition_engine.get_foods_with_nutrients_bulk(food_ids)
    out = []
    for food_id, canonical_name in scored_ids:
        entry = {
            "key": food_id,
            "name": canonical_name,
            "unit": "100g",
            "kcal_per_unit": 0,
            "protein_g_per_unit": 0,
            "carbs_g_per_unit": 0,
            "fat_g_per_unit": 0,
            "_source": "nutri_foods",
        }
        for n in nutrients_by_food.get(food_id, []):
            field = _NUTRI_NUTRIENT_MAP.get(n["nutrient_code"])
            if field and n["amount"] is not None:
                entry[field] = n["amount"]
        food = foods_by_id.get(food_id)
        if food:
            for flag in ("vegetarian", "vegan", "eggetarian", "jain"):
                if food.get(flag) is not None:
                    entry[flag] = food[flag]
        out.append(entry)
    return out


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


@app.get("/foods/search")
def foods_search(q: str, request: Request, limit: int = 20):
    """Search the real Food Intelligence Graph (nutri_foods/nutri_food_aliases)
    so a swapped ingredient is backed by the same provenance-tracked data as
    the new /api/nutrition/* surface, instead of the old, thinner `foods`
    table. This is a plain local lookup -- NOT a Gemini call -- so, like
    barcode, it requires a signed-in account but never reserves or consumes
    a free-scan credit.

    Batched to a small, FIXED number of DB round-trips regardless of result
    count (one match query, one all-aliases-for-matches query, then two more
    for the final page's nutrients/flags) -- a previous version issued one
    extra query PER matched row before scoring, which measured ~50ms/row
    against the remote pooler and made the endpoint feel "slow" under any
    query returning more than a handful of matches."""
    auth.require_account(request)
    query = _norm(q)
    if not query:
        return {"results": []}
    limit = max(1, min(50, limit))
    like = f"%{query}%"
    with db.connect() as c:
        rows = c.execute(
            """
            SELECT DISTINCT f.food_id, f.canonical_name
            FROM nutri_foods f
            LEFT JOIN nutri_food_aliases a ON a.food_id = f.food_id
            WHERE LOWER(f.canonical_name) LIKE ? OR LOWER(a.alias) LIKE ?
            """,
            (like, like),
        ).fetchall()
    matched_ids = [r["food_id"] for r in rows]
    alias_map: dict[str, list[str]] = {}
    if matched_ids:
        placeholders = ",".join(["?"] * len(matched_ids))
        with db.connect() as c:
            alias_rows = c.execute(
                f"SELECT food_id, alias FROM nutri_food_aliases WHERE food_id IN ({placeholders})",
                tuple(matched_ids),
            ).fetchall()
        for a in alias_rows:
            alias_map.setdefault(a["food_id"], []).append(a["alias"])
    scored = []
    for r in rows:
        food = {"key": r["food_id"], "aliases": alias_map.get(r["food_id"], []) + [r["canonical_name"]]}
        s = _search_score(query, food)
        if s > 0:
            scored.append((s, -len(r["canonical_name"]), r["food_id"], r["canonical_name"]))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    top = scored[:limit]
    results = _nutri_food_suggestions_batch([(fid, name) for _, _, fid, name in top])
    if results:
        return {"results": results}
    # Fall back to the old FOOD_DB only if the new graph has zero matches
    # (e.g. a dish only ever existed in the old curated set) -- never silently
    # hides a real nutri_foods result behind an old one.
    scored_old = []
    for food in FOOD_DB:
        s = _search_score(query, food)
        if s > 0:
            scored_old.append((s, -len(food["key"]), food))
    scored_old.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return {"results": [_food_suggestion(f) for _, _, f in scored_old[:limit]]}


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
        entry = _resolve_combo_entry(nm)
        if not entry:
            continue
        for side in entry.get("sides", []):
            sk = side.get("key")
            if not sk or sk in seen or sk in present:
                continue
            food = FOOD_BY_KEY.get(sk)
            if not food:
                continue  # curated key not in the food DB -> silently skip
            seen.add(sk)
            sug = _food_suggestion(food)
            sug["count"] = side.get("count", 1)
            if side.get("reason"):
                sug["reason"] = side["reason"]
            sug["pairs_with"] = entry.get("display", nm)
            out.append(sug)

    limit = max(1, min(20, limit))
    return {"pairings": out[:limit]}


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
    """Whether a DB food is allowed for the user's diet. For NUTRI_FOOD_DB
    entries, uses the real ingredient-aware vegetarian/vegan/eggetarian
    columns backfilled by dietary_rules.py (more accurate than name-word
    matching -- see checkpoint notes on the "Hot Tea" fix). Falls back to
    the word-list heuristic only for old-FOOD_DB entries with no real flags."""
    if diet == "nonveg":
        return True
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


def _recommend_score(food: dict, rem: dict, goal: dict) -> float:
    """Rank a single real DB food by how well one serving fits what's LEFT in
    the user's day. Mirrors the client's deterministic scorer (protein-first,
    penalise calorie/fat overshoot, small goal tilt) so server and client agree,
    plus a gentle nudge toward the app's health_score. Training-context bias
    stays on the client."""
    kcal = food.get("kcal_per_unit", 0) or 0
    if kcal <= 0:
        return -1e9
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
    if isinstance(hs, (int, float)):
        score += (hs - 50) * 0.03
    return score


def _rank_foods(rem: dict, goal: dict, diet: str, limit: int) -> list:
    """Return the top real DB foods for the remaining budget + diet. A serving
    must fit the calorie headroom (with a little slack) so we never suggest a
    600 kcal thali when only 200 kcal remain. Ranks over the real Food
    Intelligence Graph (NUTRI_FOOD_DB) now that it carries real macros and
    ingredient-aware diet flags; falls back to the old FOOD_DB only if the
    nutri table failed to load."""
    remKcal = rem["kcal"]
    ceiling = max(remKcal * 1.2, 150)  # allow small foods even when nearly full
    source = NUTRI_FOOD_DB or FOOD_DB
    scored = []
    for food in source:
        if not _food_diet_ok(food, diet):
            continue
        kcal = food.get("kcal_per_unit", 0) or 0
        if kcal <= 0 or kcal > ceiling:
            continue
        s = _recommend_score(food, rem, goal)
        scored.append((_india_tier(food), s, -kcal, food))
    # India-first tier is the primary key, then macro-fit, then smaller serving.
    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    return [f for _, _, _, f in scored[:limit]]


# AI phrasing is cached so rapid re-renders / similar budgets don't re-hit
# Gemini. Keyed by a COARSE bucket of the request (diet, goal, slot, calorie
# bucket, protein bucket, top-food key) with a short TTL. Best-effort: any AI
# failure falls back to deterministic text, so the endpoint never breaks.
_PHRASE_TTL = 600  # seconds
_PHRASE_CACHE_MAX = 512
_phrase_cache: dict = {}
_phrase_lock = threading.Lock()


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


class Remaining(BaseModel):
    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0


class RecommendBody(BaseModel):
    remaining: Remaining
    diet: str = "veg"
    goal: str = "maintain"
    slot: str = ""
    limit: int = 12
    phrase: bool = True


@app.post("/foods/recommend")
def foods_recommend(body: RecommendBody, request: Request):
    """Real "what to eat next" over the WHOLE food DB (839+ dishes), ranked
    against the user's ACTUAL remaining macros and filtered to their diet
    server-side (where the veg/non-veg/jain data lives). Optionally adds a
    Gemini-composed one-liner grounded in the ranked foods. Like /foods/search
    this is a plain DB lookup -- it requires a signed-in account but NEVER
    consumes a free-scan credit and never calls the vision model."""
    auth.require_account(request)
    rem = {
        "kcal": max(0.0, body.remaining.kcal),
        "protein_g": max(0.0, body.remaining.protein_g),
        "carbs_g": max(0.0, body.remaining.carbs_g),
        "fat_g": max(0.0, body.remaining.fat_g),
    }
    goal = {"goal": (body.goal or "maintain").strip().lower()}
    # protein target isn't sent; derive a proxy so the protein-priority switch
    # still works: if a real gap exists, treat protein as a priority.
    goal["protein_g"] = rem["protein_g"] * 3 if rem["protein_g"] > 0 else 0
    diet = (body.diet or "veg").strip().lower()
    limit = max(1, min(24, body.limit))

    top = _rank_foods(rem, goal, diet, limit)
    out = {"results": [_food_suggestion(f) for f in top]}
    if body.phrase:
        try:
            out["suggestion"] = _ai_phrase(diet, goal, (body.slot or "").strip().lower(), rem, top)
        except Exception:
            out["suggestion"] = _deterministic_phrase(top, rem)
    return out


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
        "db_foods_nutri": len(NUTRI_FOOD_DB),
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
def _plan_pick_for_slot(budget: dict, diet: str, goal_str: str, limit: int) -> list:
    """Top real DB foods that fit a single slot's calorie/macro budget, already
    diet-filtered and in the client-friendly _food_suggestion shape. Reuses the
    exact ranking the /foods/recommend endpoint uses so the plan and the (later)
    recommender stay consistent."""
    goal = {"goal": goal_str, "protein_g": budget.get("protein_g", 0) * 3}
    top = _rank_foods(budget, goal, diet, limit)
    return [_food_suggestion(f) for f in top]


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


plan.init_db()
plan.configure(pick_for_slot=_plan_pick_for_slot, ai_note=_plan_ai_note)
app.include_router(plan.router)

