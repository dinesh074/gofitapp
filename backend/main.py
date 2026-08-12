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
import logging
import threading
from collections import defaultdict, deque

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
import google.generativeai as genai

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
import progress
import barcode
import wellness

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gofit")

MODEL = os.environ.get("FOOD_MODEL", "gemini-3.5-flash-lite")

# temperature=0 => deterministic: the same photo yields the same numbers.
# response_mime_type => model returns strict JSON (no markdown fences).
GEN_CONFIG = {
    "temperature": 0,
    "top_p": 1,
    "response_mime_type": "application/json",
}

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
      "countable": <true if a discrete countable item like idli/samosa, false for mixed plates/curries>
    }
  ],
  "calories_kcal": <sum of all items kcal_total>,
  "confidence": <0.0-1.0>
}
Use standard Indian household portions. Break a plate into its components
(rice + dal + sabzi). Estimate kcal_per_unit for a normal home serving.
Count only what is clearly visible."""

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
      "countable": <true if a discrete countable item like idli/samosa, false for mixed plates/curries>
    }
  ],
  "calories_kcal": <sum of all items kcal_total>,
  "confidence": <0.0-1.0, LOWER than you'd give a clear photo -- text descriptions
    are inherently more ambiguous about portion size>
}
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


def _food_suggestion(food: dict) -> dict:
    """Map a FOOD_DB record to the shape the client turns into a FoodItem when
    a user swaps a mis-identified ingredient. DB macros are already per-unit."""
    out = {
        "key": food["key"],
        "name": food["key"].replace("_", " ").title(),
        "unit": food["unit"],
        "kcal_per_unit": food["kcal_per_unit"],
        "protein_g_per_unit": food.get("protein_g", 0),
        "carbs_g_per_unit": food.get("carbs_g", 0),
        "fat_g_per_unit": food.get("fat_g", 0),
    }
    for k in ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg", "health_score"):
        if food.get(k) is not None:
            out[k] = food[k]
    for k in ("benefits", "watch_outs", "micros"):
        if food.get(k):
            out[k] = food[k]
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
    """Free, in-memory search over the food DB so users can swap a
    mis-identified ingredient for the right one. This is a plain local lookup
    -- NOT a Gemini call -- so, like barcode, it requires a signed-in account
    but never reserves or consumes a free-scan credit."""
    auth.require_account(request)
    query = _norm(q)
    if not query:
        return {"results": []}
    scored = []
    for food in FOOD_DB:
        s = _search_score(query, food)
        if s > 0:
            # Tie-break shorter (more specific) names ahead of long ones.
            scored.append((s, -len(food["key"]), food))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    limit = max(1, min(50, limit))
    return {"results": [_food_suggestion(f) for _, _, f in scored[:limit]]}


def anchor_items(data: dict) -> dict:
    """Override per-unit calories AND macros with DB values when matched, then
    compute per-item and meal-level totals.

    v2: also carries through the extended DB fields where present --
    micronutrients (fiber/sugar/sodium/potassium/calcium/iron) scale with
    count just like the macros; health_score/benefits/watch_outs describe the
    food itself and are copied as-is (a "high in sodium" tag doesn't change
    because you ate two servings, so these are not multiplied by count)."""
    macros = ("protein_g", "carbs_g", "fat_g")
    micro_fields = ("fiber_g", "sugar_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg")
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
        else:
            # fall back to the model's own per-unit macro estimates
            for m in macros:
                it[m + "_per_unit"] = it.get(m, 0)
            it["source"] = "ai"
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
    for it in items:
        for k, v in it.get("micros", {}).items():
            micro_totals[k] = micro_totals.get(k, 0) + v
    if micro_totals:
        totals["micros"] = {k: round(v, 4) for k, v in micro_totals.items()}
    data["totals"] = totals
    return data
# -----------------------------------------------------------------------------

_model = None


def get_model():
    global _model
    if _model is None:
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        genai.configure(api_key=key)
        _model = genai.GenerativeModel(MODEL, generation_config=GEN_CONFIG)
    return _model


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


def _run_gemini_analysis(account: dict, prompt: str, media, error_detail_prefix: str) -> dict:
    """Shared retry/anchor/usage/scan-history plumbing for both the image and
    text analysis paths -- media is either a PIL.Image (photo) or omitted
    (text-only prompt already has the description baked in)."""
    last = None
    for attempt in range(3):
        try:
            parts = [prompt, media] if media is not None else [prompt]
            resp = get_model().generate_content(parts)
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
            data = anchor_items(data)
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


@app.post("/analyze")
async def analyze(request: Request, file: UploadFile = File(...), _: None = Depends(guard)):
    account = _require_scan_slot(request)

    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="File must be an image")
    try:
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Empty file")
        if len(raw) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 8MB)")
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((768, 768))  # downscale: big speed win, negligible accuracy loss
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or unreadable image")

    return _run_gemini_analysis(account, PROMPT, img, "photo")


class TextAnalyzeBody(BaseModel):
    description: str = Field(..., min_length=2, max_length=500)


@app.post("/analyze/text")
def analyze_text(body: TextAnalyzeBody, request: Request, _: None = Depends(guard)):
    """Text (or voice-transcribed-to-text) meal logging -- same free-scan
    gate, same DB-anchoring, same response shape as the photo path, just
    without an image. Lets you log a meal by describing it when a photo
    isn't practical."""
    account = _require_scan_slot(request)
    prompt = f'{TEXT_PROMPT}\n\nUser\'s description: "{body.description.strip()}"'
    return _run_gemini_analysis(account, prompt, None, "description")
