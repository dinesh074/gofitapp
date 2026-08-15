"""
gofit.today — the tables that were missing: profile, meal logs, weight history.

Before this module, an account's onboarding profile (age/height/weight/diet/
goal) and everything logged (scanned meals, weight check-ins) lived ONLY in
the client's local storage -- real data, computed for real, but with no
table to persist it anywhere durable. Switching devices, clearing browser
storage, or just using a different web origin lost it completely, and
looked indistinguishable from a fresh account. This module gives each of
those three things a real table keyed by account_id, so the account (which
already persists correctly) is the actual source of truth for its data too.

The client keeps its local cache for a fast boot (same stale-while-revalidate
pattern as auth.py's account refresh) -- these endpoints are what makes that
cache eventually correct instead of the only copy that exists.

Endpoints (all Bearer-authenticated):
  GET  /profile          -> {profile: {...} | null}, profile.bmi computed live
                             from height/weight (not stored -- nothing to drift)
  PUT  /profile          -> upsert the caller's profile
  GET  /logs             -> {logs: {"YYYY-MM-DD": {date, meals: [...]}}}
  POST /logs             -> append one meal to a date, returns its id
  DELETE /logs/{id}      -> remove one meal (must belong to the caller)
  GET  /weights          -> {weights: [{kg, at}, ...]}
  POST /weights          -> append one weight check-in
  GET  /summary          -> cached per-day totals (daily_summary), fast even
                             as meal_logs grows -- kept correct by
                             _refresh_daily_summary() on every log add/delete
  GET  /scans/history    -> every /analyze attempt (scan_history), including
                             ones that failed or were never logged
  GET  /streak           -> {current, best} durable streak (see log_days)
  GET  /log-days?days=N  -> {days: ["YYYY-MM-DD", ...]} durable logged-date
                             list (N<=0 = all-time), never truncated by the
                             30-day meal-detail retention -- powers the
                             Progress tab's consistency score + heatmap
                             beyond the 30-day meal_logs window
"""
import json
import time
import logging
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
import auth
import blob_storage
import food_graph

log = logging.getLogger("gofit.progress")

router = APIRouter(tags=["progress"])

# Retention policy (user-facing ask: "up to one month old logs" / "7 day old
# images after that"): meal macros/times/types stay queryable for 30 days,
# then the row itself is dropped. The photo is deleted from Storage (and its
# path cleared) after only 7 days -- the diary entry survives longer than the
# picture of it does.
RETENTION_LOG_DAYS = 30
RETENTION_PHOTO_DAYS = 7


def _ensure_column(c, table: str, column: str, decl: str) -> None:
    """Add a column if it's missing, so older databases pick up new fields
    without a migration framework. Works on both SQLite and Postgres by using
    db.table_columns() for introspection (PRAGMA is SQLite-only and errors on
    Postgres). Neither backend's ALTER TABLE ADD COLUMN needs the column to be
    absent-checked beyond this."""
    if column not in db.table_columns(c, table):
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                account_id       INTEGER PRIMARY KEY,
                name             TEXT,
                gender           TEXT NOT NULL,
                age              INTEGER NOT NULL,
                height_cm        REAL NOT NULL,
                weight_kg        REAL NOT NULL,
                target_weight_kg REAL NOT NULL,
                goal             TEXT NOT NULL,
                activity         TEXT NOT NULL,
                diet             TEXT NOT NULL,
                goal_pace        TEXT,
                goal_kind        TEXT,
                created_at       REAL NOT NULL,
                updated_at       REAL NOT NULL
            )
            """
        )
        # Additive columns for the onboarding redesign. Guarded so existing
        # databases (created before these columns) get them without a migration
        # tool. goal_pace / goal_kind are nullable; the client + server both fall
        # back sensibly when absent (see resolveGoalPace / resolveGoalKind).
        _ensure_column(c, "profiles", "goal_pace", "TEXT")
        _ensure_column(c, "profiles", "goal_kind", "TEXT")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS meal_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                dish       TEXT NOT NULL,
                kcal       REAL NOT NULL,
                protein_g  REAL NOT NULL,
                carbs_g    REAL NOT NULL,
                fat_g      REAL NOT NULL,
                at         REAL NOT NULL
            )
            """
        )
        # meal_type: breakfast / morning_snack / lunch / afternoon_snack /
        # evening_snack / dinner -- inferred client-side from the local time
        # the meal was logged (see storage.ts's inferMealType), stored as-is.
        # photo_path: object path in the private meal-photos Storage bucket
        # (see blob_storage.py); NULL once the 7-day photo-retention window
        # has passed or if the photo upload failed/was never taken.
        _ensure_column(c, "meal_logs", "meal_type", "TEXT")
        _ensure_column(c, "meal_logs", "photo_path", "TEXT")
        # micros: JSON-encoded {nutrient_key: value} panel (fibre, iron, sodium,
        # etc. -- see app/micros.ts's MICRO_REFS), summed at log time from any
        # DB-matched items. Previously this only lived in the client's local
        # state and was silently dropped on every server round-trip (a reload
        # or a different device would just lose it) -- persisting it here is
        # what makes the day/meal detail views' nutrient panels actually real.
        _ensure_column(c, "meal_logs", "micros", "TEXT")
        # micros_estimated: true when ANY contributing item's micros came from
        # the vision model's own best-guess estimate rather than a verified
        # food-DB match (see main.py's anchor_items/micros_source). Lets the
        # client show an honest "Estimated" note instead of presenting a
        # guess as verified lab data.
        _ensure_column(c, "meal_logs", "micros_estimated", "INTEGER")
        # Optional full itemized payload from scan/manual logging. Keeps the
        # per-item unit metrics (kcal/macros per unit, micros source/panel, etc.)
        # alongside the high-level meal totals for exact replay/audit.
        _ensure_column(c, "meal_logs", "food_items_json", "TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS idx_meal_logs_account_date ON meal_logs(account_id, date)")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS weight_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                kg         REAL NOT NULL,
                at         REAL NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_weight_logs_account ON weight_logs(account_id)")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS scan_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id  INTEGER NOT NULL,
                success     INTEGER NOT NULL,
                item_count  INTEGER,
                total_kcal  REAL,
                error_detail TEXT,
                created_at  REAL NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_scan_history_account ON scan_history(account_id, created_at)")
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS daily_summary (
                account_id   INTEGER NOT NULL,
                date         TEXT NOT NULL,
                kcal         REAL NOT NULL DEFAULT 0,
                protein_g    REAL NOT NULL DEFAULT 0,
                carbs_g      REAL NOT NULL DEFAULT 0,
                fat_g        REAL NOT NULL DEFAULT 0,
                meals_count  INTEGER NOT NULL DEFAULT 0,
                updated_at   REAL NOT NULL,
                PRIMARY KEY (account_id, date)
            )
            """
        )
        # Durable, permanent record of "this account logged >=1 meal on this
        # calendar date" -- deliberately NEVER touched by RETENTION_LOG_DAYS
        # cleanup (unlike meal_logs/daily_summary, which age out at 30 days).
        # This is the whole point: a user's real streak (current AND best)
        # must survive both a reinstall (it's server-side, not recomputed
        # from a local cache) and the 30-day log-retention purge (a 90-day
        # streak shouldn't silently cap at 30 just because we stop keeping
        # the old macro/photo detail). No PII/macros here, just a date --
        # cheap to keep forever.
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS log_days (
                account_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                PRIMARY KEY (account_id, date)
            )
            """
        )
        # One-time backfill: accounts with logging history from before this
        # table existed shouldn't show a broken/zero streak on their first
        # request after this deploy. Safe to run every boot -- INSERT is
        # idempotent (ON CONFLICT DO NOTHING) and only adds rows that are
        # still within the 30-day meal_logs window at backfill time; any
        # streak established before this deploy that's already older than
        # that has no surviving source data to backfill from regardless.
        c.execute(
            """
            INSERT INTO log_days (account_id, date)
            SELECT DISTINCT account_id, date FROM meal_logs
            WHERE NOT EXISTS (
                SELECT 1 FROM log_days ld
                WHERE ld.account_id = meal_logs.account_id AND ld.date = meal_logs.date
            )
            """
        )


def _touch_log_day(c, account_id: int, date_key: str) -> None:
    """Record that this account logged >=1 meal on date_key. Idempotent."""
    c.execute(
        "INSERT INTO log_days (account_id, date) VALUES (?,?) ON CONFLICT(account_id, date) DO NOTHING",
        (account_id, date_key),
    )


def _untouch_log_day_if_empty(c, account_id: int, date_key: str) -> None:
    """After deleting a meal, drop the log_days row for that date too -- but
    ONLY if no meals remain on that date (deleting one meal from a day that
    still has others shouldn't break the streak for that day)."""
    remaining = c.execute(
        "SELECT COUNT(*) AS n FROM meal_logs WHERE account_id=? AND date=?",
        (account_id, date_key),
    ).fetchone()
    if remaining["n"] == 0:
        c.execute("DELETE FROM log_days WHERE account_id=? AND date=?", (account_id, date_key))


def compute_streaks(c, account_id: int) -> dict:
    """Current + best streak computed from the durable log_days table (never
    purged by the 30-day meal-retention policy, unlike meal_logs/daily_summary
    -- see log_days' table comment). Mirrors the client's storage.ts
    computeStreak/bestStreak semantics: "current" counts consecutive days
    ending today (or yesterday, if today has nothing logged yet); "best" is
    the longest consecutive run across all history."""
    rows = c.execute(
        "SELECT date FROM log_days WHERE account_id=? ORDER BY date ASC",
        (account_id,),
    ).fetchall()
    days = [r["date"] for r in rows]
    if not days:
        return {"current": 0, "best": 0}

    day_set = set(days)
    from datetime import date as _date, timedelta as _timedelta

    today = _date.today()

    def _key(d: _date) -> str:
        return d.isoformat()

    # Current streak: walk back from today (or yesterday if today's empty).
    cursor = today
    if _key(cursor) not in day_set:
        cursor = cursor - _timedelta(days=1)
    current = 0
    while _key(cursor) in day_set:
        current += 1
        cursor = cursor - _timedelta(days=1)

    # Best streak: longest run of consecutive calendar dates in log_days.
    best = 0
    run = 0
    prev: Optional[_date] = None
    for d_str in days:
        cur = _date.fromisoformat(d_str)
        if prev is not None and (cur - prev).days == 1:
            run += 1
        else:
            run = 1
        best = max(best, run)
        prev = cur

    return {"current": current, "best": best}


def record_scan(
    account_id: int,
    success: bool,
    item_count: Optional[int] = None,
    total_kcal: Optional[float] = None,
    error_detail: Optional[str] = None,
) -> None:
    """Log every /analyze attempt -- not just the ones the user goes on to
    confirm/log (that's meal_logs' job). Lets us actually answer "how many
    times has this account scanned, and how often did it fail" instead of
    only ever knowing about the successes someone chose to keep."""
    try:
        with db.write_lock(), db.connect() as c:
            c.execute(
                "INSERT INTO scan_history (account_id, success, item_count, total_kcal, error_detail, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (account_id, 1 if success else 0, item_count, total_kcal, error_detail, time.time()),
            )
    except Exception:
        log.exception("scan_history write failed for account %s", account_id)


def _refresh_daily_summary(c, account_id: int, date_key: str) -> None:
    """Recompute one account/date's cached totals directly from meal_logs --
    called after any log add/delete so daily_summary never drifts from the
    real rows it's summarizing."""
    row = c.execute(
        """
        SELECT COALESCE(SUM(kcal),0) AS kcal, COALESCE(SUM(protein_g),0) AS protein_g,
               COALESCE(SUM(carbs_g),0) AS carbs_g, COALESCE(SUM(fat_g),0) AS fat_g,
               COUNT(*) AS n
        FROM meal_logs WHERE account_id=? AND date=?
        """,
        (account_id, date_key),
    ).fetchone()
    if row["n"] == 0:
        c.execute("DELETE FROM daily_summary WHERE account_id=? AND date=?", (account_id, date_key))
        return
    c.execute(
        """
        INSERT INTO daily_summary (account_id, date, kcal, protein_g, carbs_g, fat_g, meals_count, updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id, date) DO UPDATE SET
            kcal=excluded.kcal, protein_g=excluded.protein_g, carbs_g=excluded.carbs_g,
            fat_g=excluded.fat_g, meals_count=excluded.meals_count, updated_at=excluded.updated_at
        """,
        (account_id, date_key, row["kcal"], row["protein_g"], row["carbs_g"], row["fat_g"], row["n"], time.time()),
    )


def _bmi(height_cm: float, weight_kg: float) -> Optional[dict]:
    """Standard BMI (kg / m^2) plus the standard WHO category bands. Purely
    computed from real profile data, not stored -- there's nothing to drift
    out of sync, so no table needed for this one."""
    if not height_cm or height_cm <= 0:
        return None
    m = height_cm / 100.0
    value = round(weight_kg / (m * m), 1)
    if value < 18.5:
        category = "underweight"
    elif value < 25:
        category = "normal"
    elif value < 30:
        category = "overweight"
    else:
        category = "obese"
    return {"value": value, "category": category}


# --- profile -------------------------------------------------------------- #

class ProfileBody(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    gender: str
    age: int = Field(..., ge=1, le=120)
    heightCm: float = Field(..., gt=0, le=300)
    weightKg: float = Field(..., gt=0, le=500)
    targetWeightKg: float = Field(..., gt=0, le=500)
    goal: str
    activity: str
    diet: str
    goalPace: Optional[str] = None
    goalKind: Optional[str] = None


_VALID_GENDERS = {"male", "female", "other"}
_VALID_GOALS = {"lose", "maintain", "gain"}
_VALID_ACTIVITIES = {"sedentary", "light", "moderate", "active", "very_active"}
_VALID_DIETS = {"veg", "nonveg", "eggetarian", "vegan", "jain", "sattvic"}
_GOAL_PACE_ALIASES = {
    "relaxed": "relaxed",
    "slow": "relaxed",
    "recommended": "recommended",
    "steady": "recommended",
    "moderate": "recommended",
    "ambitious": "ambitious",
    "aggressive": "ambitious",
}
_GOAL_KIND_ALIASES = {
    "loss": "loss",
    "lose": "loss",
    "lose_weight": "loss",
    "weight_loss": "loss",
    "muscle": "muscle",
    "gain_muscle": "muscle",
    "muscle_gain": "muscle",
    "maintain": "maintain",
    "maintenance": "maintain",
    "fitness": "fitness",
    "general_fitness": "fitness",
}


def _coerce_choice(value: Optional[str], valid: set[str], field_name: str) -> str:
    v = (value or "").strip().lower()
    if v not in valid:
        raise HTTPException(status_code=422, detail=f"Invalid {field_name}: {value}")
    return v


def _normalize_goal_kind(goal_kind: Optional[str], goal: str) -> str:
    raw = (goal_kind or "").strip().lower()
    if raw:
        mapped = _GOAL_KIND_ALIASES.get(raw)
        if not mapped:
            raise HTTPException(status_code=422, detail=f"Invalid goalKind: {goal_kind}")
        return mapped
    if goal == "lose":
        return "loss"
    if goal == "gain":
        return "muscle"
    return "maintain"


def _normalize_goal_pace(goal_pace: Optional[str], goal_kind: str) -> Optional[str]:
    if goal_kind not in {"loss", "muscle"}:
        return None
    if goal_pace is None:
        return "recommended"
    raw = goal_pace.strip().lower()
    mapped = _GOAL_PACE_ALIASES.get(raw)
    if not mapped:
        raise HTTPException(status_code=422, detail=f"Invalid goalPace: {goal_pace}")
    return mapped


def _goal_from_kind(goal_kind: str) -> str:
    if goal_kind == "loss":
        return "lose"
    if goal_kind == "muscle":
        return "gain"
    return "maintain"


def _row_to_profile(row) -> dict:
    return {
        "name": row["name"],
        "gender": row["gender"],
        "age": row["age"],
        "heightCm": row["height_cm"],
        "weightKg": row["weight_kg"],
        "targetWeightKg": row["target_weight_kg"],
        "goal": row["goal"],
        "activity": row["activity"],
        "diet": row["diet"],
        "goalPace": (row["goal_pace"] if "goal_pace" in row.keys() else None),
        "goalKind": (row["goal_kind"] if "goal_kind" in row.keys() else None),
        "createdAt": row["created_at"],
        # Server's last-write timestamp for this profile row. The client uses
        # this (Profile.updatedAt) to decide whether an incoming server
        # profile is actually newer than what's currently in memory/local
        # storage -- without it, a client edit that's still in-flight (or
        # whose PUT silently failed in a previous build) could get clobbered
        # by a stale GET /profile response on the next app load. See
        # App.tsx's shouldApplyServerProfile().
        "updatedAt": (row["updated_at"] if "updated_at" in row.keys() else None),
        # Computed, not stored -- always current with whatever weight/height
        # is on the profile right now, nothing to keep in sync.
        "bmi": _bmi(row["height_cm"], row["weight_kg"]),
    }


@router.get("/profile")
def get_profile(request: Request):
    acct = auth.require_account(request)
    with db.connect() as c:
        row = c.execute(
            "SELECT * FROM profiles WHERE account_id=?", (acct["id"],)
        ).fetchone()
    return {"profile": _row_to_profile(row) if row else None}


@router.put("/profile")
def put_profile(body: ProfileBody, request: Request):
    acct = auth.require_account(request)
    gender = _coerce_choice(body.gender, _VALID_GENDERS, "gender")
    goal = _coerce_choice(body.goal, _VALID_GOALS, "goal")
    activity = _coerce_choice(body.activity, _VALID_ACTIVITIES, "activity")
    diet = _coerce_choice(body.diet, _VALID_DIETS, "diet")
    goal_kind = _normalize_goal_kind(body.goalKind, goal)
    goal = _goal_from_kind(goal_kind)
    goal_pace = _normalize_goal_pace(body.goalPace, goal_kind)
    now = time.time()
    with db.write_lock(), db.connect() as c:
        existing = c.execute(
            "SELECT created_at FROM profiles WHERE account_id=?", (acct["id"],)
        ).fetchone()
        created_at = existing["created_at"] if existing else now
        c.execute(
            """
            INSERT INTO profiles
                (account_id, name, gender, age, height_cm, weight_kg,
                 target_weight_kg, goal, activity, diet, goal_pace, goal_kind,
                 created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
                name=excluded.name, gender=excluded.gender, age=excluded.age,
                height_cm=excluded.height_cm, weight_kg=excluded.weight_kg,
                target_weight_kg=excluded.target_weight_kg, goal=excluded.goal,
                activity=excluded.activity, diet=excluded.diet,
                goal_pace=excluded.goal_pace, goal_kind=excluded.goal_kind,
                updated_at=excluded.updated_at
            """,
            (
                acct["id"], body.name, gender, body.age, body.heightCm,
                body.weightKg, body.targetWeightKg, goal, activity,
                diet, goal_pace, goal_kind, created_at, now,
            ),
        )
        row = c.execute(
            "SELECT * FROM profiles WHERE account_id=?", (acct["id"],)
        ).fetchone()
    return {"profile": _row_to_profile(row)}


# --- meal logs -------------------------------------------------------------- #

class MealBody(BaseModel):
    date: str = Field(..., min_length=10, max_length=10)  # "YYYY-MM-DD"
    dish: str = Field(..., min_length=1, max_length=200)
    kcal: float = Field(..., ge=0, le=20000)
    protein_g: float = Field(0, ge=0, le=2000)
    carbs_g: float = Field(0, ge=0, le=2000)
    fat_g: float = Field(0, ge=0, le=2000)
    # One of breakfast/morning_snack/lunch/afternoon_snack/evening_snack/dinner
    # (see storage.ts MEAL_TYPES) -- optional so older clients keep working;
    # server infers a best-effort bucket from `at` when absent (see below).
    meal_type: Optional[str] = Field(None, max_length=32)
    # Storage object path returned by /analyze's photo_path -- only meaningful
    # if this meal came from a scan that successfully uploaded its photo.
    photo_path: Optional[str] = Field(None, max_length=300)
    # Per-nutrient totals for this meal (see app/micros.ts's MICRO_REFS) --
    # optional since a pure-AI photo estimate has no reliable micro panel.
    micros: Optional[Dict[str, float]] = None
    # True when ANY item contributing to `micros` came from the vision
    # model's own best-guess estimate rather than a verified food-DB match
    # (see main.py's anchor_items/micros_source, totals.micros_estimated).
    micros_estimated: Optional[bool] = None
    # Optional itemized food rows used for canonical reference-based logging.
    food_items: Optional[list[dict]] = None


_MEAL_TYPES = {"breakfast", "morning_snack", "lunch", "afternoon_snack", "evening_snack", "dinner"}


def _infer_meal_type(at_epoch: float) -> str:
    """Best-effort fallback bucket when the client didn't send meal_type.
    Uses server local time -- imperfect across timezones, which is exactly
    why the client (which knows the user's real local time) should always
    send its own inferMealType() result; this only covers old/broken clients."""
    hour = time.localtime(at_epoch).tm_hour
    if 5 <= hour < 10:
        return "breakfast"
    if 10 <= hour < 12:
        return "morning_snack"
    if 12 <= hour < 15:
        return "lunch"
    if 15 <= hour < 18:
        return "afternoon_snack"
    if 18 <= hour < 20:
        return "evening_snack"
    return "dinner"


def _cleanup_account(c, account_id: int) -> None:
    """Enforces the retention policy for one account, scoped to just their
    rows (cheap at personal-diary scale): logs older than
    RETENTION_LOG_DAYS are dropped entirely (photo deleted from Storage
    first); logs between the photo- and log-retention windows keep their
    macros/dish/time but lose the photo (deleted from Storage, path cleared).
    Called opportunistically from GET /logs so this stays correct without
    needing a separate cron job. Best-effort -- never raises, so a Storage
    hiccup can't break someone's ability to read their own log."""
    try:
        now = time.time()
        log_cutoff = now - RETENTION_LOG_DAYS * 86400
        photo_cutoff = now - RETENTION_PHOTO_DAYS * 86400

        expired = c.execute(
            "SELECT id, date, photo_path FROM meal_logs WHERE account_id=? AND at < ?",
            (account_id, log_cutoff),
        ).fetchall()
        if expired:
            for r in expired:
                if r["photo_path"]:
                    blob_storage.delete_meal_photo(r["photo_path"])
            c.execute("DELETE FROM meal_logs WHERE account_id=? AND at < ?", (account_id, log_cutoff))
            for d in {r["date"] for r in expired}:
                _refresh_daily_summary(c, account_id, d)

        stale_photos = c.execute(
            "SELECT id, photo_path FROM meal_logs WHERE account_id=? AND at < ? AND at >= ? AND photo_path IS NOT NULL",
            (account_id, photo_cutoff, log_cutoff),
        ).fetchall()
        for r in stale_photos:
            blob_storage.delete_meal_photo(r["photo_path"])
        if stale_photos:
            c.execute(
                "UPDATE meal_logs SET photo_path=NULL WHERE account_id=? AND at < ? AND at >= ? AND photo_path IS NOT NULL",
                (account_id, photo_cutoff, log_cutoff),
            )
    except Exception:
        log.exception("retention cleanup failed for account %s", account_id)


@router.get("/logs")
def get_logs(request: Request):
    acct = auth.require_account(request)
    with db.write_lock(), db.connect() as c:
        _cleanup_account(c, acct["id"])
        rows = c.execute(
            "SELECT * FROM meal_logs WHERE account_id=? AND at >= ? ORDER BY at ASC",
            (acct["id"], time.time() - RETENTION_LOG_DAYS * 86400),
        ).fetchall()
    logs: dict = {}
    for r in rows:
        d = r["date"]
        if d not in logs:
            logs[d] = {"date": d, "meals": []}
        photo_url = None
        photo_path = r["photo_path"] if "photo_path" in r.keys() else None
        if photo_path:
            photo_url = blob_storage.signed_url(photo_path)
        micros_raw = r["micros"] if "micros" in r.keys() else None
        micros = None
        if micros_raw:
            try:
                micros = json.loads(micros_raw)
            except (TypeError, ValueError):
                micros = None
        food_items_raw = r["food_items_json"] if "food_items_json" in r.keys() else None
        food_items = None
        if food_items_raw:
            try:
                loaded = json.loads(food_items_raw)
                food_items = loaded if isinstance(loaded, list) else None
            except (TypeError, ValueError):
                food_items = None
        logs[d]["meals"].append(
            {
                "id": r["id"],
                "dish": r["dish"],
                "kcal": r["kcal"],
                "protein_g": r["protein_g"],
                "carbs_g": r["carbs_g"],
                "fat_g": r["fat_g"],
                "at": r["at"],
                "mealType": (r["meal_type"] if "meal_type" in r.keys() else None) or _infer_meal_type(r["at"]),
                "photoUrl": photo_url,
                "micros": micros,
                "microsEstimated": bool(r["micros_estimated"]) if "micros_estimated" in r.keys() and r["micros_estimated"] is not None else False,
                "foodItems": food_items,
            }
        )
    return {"logs": logs}


@router.post("/logs")
def add_log(body: MealBody, request: Request):
    acct = auth.require_account(request)
    at = time.time()
    meal_type = body.meal_type if body.meal_type in _MEAL_TYPES else _infer_meal_type(at)
    micros_json = json.dumps(body.micros) if body.micros else None
    food_items_json = json.dumps(body.food_items) if body.food_items else None
    with db.write_lock(), db.connect() as c:
        cur = c.execute(
            "INSERT INTO meal_logs (account_id, date, dish, kcal, protein_g, carbs_g, fat_g, at, meal_type, photo_path, micros, micros_estimated, food_items_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                acct["id"], body.date, body.dish, body.kcal, body.protein_g, body.carbs_g, body.fat_g, at,
                meal_type, body.photo_path, micros_json, int(bool(body.micros_estimated)), food_items_json,
            ),
        )
        new_id = cur.lastrowid
        _refresh_daily_summary(c, acct["id"], body.date)
        _touch_log_day(c, acct["id"], body.date)
    if body.food_items:
        food_graph.record_food_log(
            acct["id"],
            body.date,
            body.dish,
            legacy_meal_log_id=new_id,
            items=body.food_items,
        )
    return {"ok": True, "id": new_id, "at": at, "mealType": meal_type}



@router.delete("/logs/{log_id}")
def delete_log(log_id: int, request: Request):
    acct = auth.require_account(request)
    with db.write_lock(), db.connect() as c:
        row = c.execute("SELECT account_id, date FROM meal_logs WHERE id=?", (log_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if row["account_id"] != acct["id"]:
            # Same principle as community.py's _requester_id -- never let a
            # caller act on another account's rows just because they guessed
            # an id.
            raise HTTPException(status_code=404, detail="Not found")
        c.execute("DELETE FROM meal_logs WHERE id=?", (log_id,))
        _refresh_daily_summary(c, acct["id"], row["date"])
        _untouch_log_day_if_empty(c, acct["id"], row["date"])
    return {"ok": True}


@router.get("/streak")
def get_streak(request: Request):
    """Current + best streak, computed server-side from the durable
    log_days table (see its table comment for why this is authoritative
    and survives both reinstalls and the 30-day log-retention purge, unlike
    the client's old local-only computeStreak/bestStreak over the last-30-
    days GET /logs response)."""
    acct = auth.require_account(request)
    with db.write_lock(), db.connect() as c:
        result = compute_streaks(c, acct["id"])
    return result


@router.get("/log-days")
def get_log_days(request: Request, days: int = 90):
    """Every calendar date (YYYY-MM-DD) this account logged >=1 meal, read
    straight from the durable log_days table -- NOT from meal_logs, which is
    purged after RETENTION_LOG_DAYS. This is what lets the Progress tab's
    logging-consistency heatmap and 90-day/all-time consistency score stay
    honest beyond the 30-day macro-detail window: we may not remember WHAT
    was eaten 60 days ago, but we do durably remember THAT something was
    logged that day. `days<=0` means "all of history"."""
    acct = auth.require_account(request)
    with db.connect() as c:
        if days <= 0:
            rows = c.execute(
                "SELECT date FROM log_days WHERE account_id=? ORDER BY date ASC",
                (acct["id"],),
            ).fetchall()
        else:
            from datetime import date as _date, timedelta as _timedelta
            cutoff = (_date.today() - _timedelta(days=days)).isoformat()
            rows = c.execute(
                "SELECT date FROM log_days WHERE account_id=? AND date >= ? ORDER BY date ASC",
                (acct["id"], cutoff),
            ).fetchall()
    return {"days": [r["date"] for r in rows]}


# --- daily summary (cache) & scan history ----------------------------------- #

@router.get("/summary")
def get_summary(request: Request, days: int = 30):
    """Cached per-day totals from daily_summary -- avoids recomputing from
    meal_logs on every read as history grows. Kept correct by
    _refresh_daily_summary(), called on every add/delete above."""
    acct = auth.require_account(request)
    days = max(1, min(days, 365))
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM daily_summary WHERE account_id=? ORDER BY date DESC LIMIT ?",
            (acct["id"], days),
        ).fetchall()
    return {
        "days": [
            {
                "date": r["date"],
                "kcal": r["kcal"],
                "protein_g": r["protein_g"],
                "carbs_g": r["carbs_g"],
                "fat_g": r["fat_g"],
                "mealsCount": r["meals_count"],
            }
            for r in rows
        ]
    }


@router.get("/scans/history")
def get_scan_history(request: Request, limit: int = 50):
    """Every /analyze attempt for this account, most recent first -- including
    ones that failed or were never turned into a logged meal. See
    record_scan(), called from main.py's /analyze."""
    acct = auth.require_account(request)
    limit = max(1, min(limit, 200))
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM scan_history WHERE account_id=? ORDER BY created_at DESC LIMIT ?",
            (acct["id"], limit),
        ).fetchall()
    return {
        "scans": [
            {
                "id": r["id"],
                "success": bool(r["success"]),
                "itemCount": r["item_count"],
                "totalKcal": r["total_kcal"],
                "error": r["error_detail"],
                "at": r["created_at"],
            }
            for r in rows
        ]
    }


# --- weight history -------------------------------------------------------- #

class WeightBody(BaseModel):
    kg: float = Field(..., gt=0, le=500)


@router.get("/weights")
def get_weights(request: Request):
    acct = auth.require_account(request)
    with db.connect() as c:
        rows = c.execute(
            "SELECT kg, at FROM weight_logs WHERE account_id=? ORDER BY at ASC",
            (acct["id"],),
        ).fetchall()
    return {"weights": [{"kg": r["kg"], "at": r["at"]} for r in rows]}


@router.post("/weights")
def add_weight(body: WeightBody, request: Request):
    acct = auth.require_account(request)
    at = time.time()
    with db.write_lock(), db.connect() as c:
        c.execute(
            "INSERT INTO weight_logs (account_id, kg, at) VALUES (?,?,?)",
            (acct["id"], body.kg, at),
        )
        rows = c.execute(
            "SELECT kg, at FROM weight_logs WHERE account_id=? ORDER BY at ASC",
            (acct["id"],),
        ).fetchall()
    return {"weights": [{"kg": r["kg"], "at": r["at"]} for r in rows]}
