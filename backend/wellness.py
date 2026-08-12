"""
gofit.today — water and habit tracking.

The reviews people leave for calorie apps repeatedly ask for two "easy win"
features that have nothing to do with the AI scanner: hydration tracking and
simple daily habit logging (steps, a workout, etc). This module adds both.

Deliberately NOT part of the scan/AI flow:
  Logging a glass of water or a step count is plain data entry -- no Gemini
  call, no barcode lookup, nothing to meter. So none of these endpoints touch
  auth.reserve_scan / the free-scan credit. They only require a signed-in
  account (like /profile and /logs in progress.py).

Endpoints (all Bearer-authenticated):
  GET  /water?date=YYYY-MM-DD   -> {date, ml, goalMl}
  POST /water   {date, ml}      -> add (ml may be negative to undo) -> {date, ml}
  GET  /habits?date=YYYY-MM-DD  -> {date, habits: {kind: value}}
  POST /habits  {date, kind, value} -> upsert one habit's value -> {date, habits}

Storage mirrors progress.py's per-account, per-date pattern so the client's
local cache can stay eventually-consistent the same way meal logs do.
"""
import time
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
import auth

log = logging.getLogger("gofit.wellness")

router = APIRouter(tags=["wellness"])

# Recognised habit kinds. Kept as a small allow-list so an arbitrary client
# can't spray unbounded key names into the table.
HABIT_KINDS = {"steps", "workout_min", "sleep_hr"}

# Fallback only, used before an account has synced a profile at all (see
# _water_goal_ml below). Once a profile exists, the goal is personalized --
# not this same number for every account regardless of who they are.
DEFAULT_WATER_GOAL_ML = 2500
DEFAULT_STEP_GOAL = 10000

# Same formulas as app/nutrition.ts's computeWaterGoalMl / computeStepGoal,
# kept in exact numeric agreement so a fresh device's server-computed goal
# always matches what the client would show once its profile syncs.
_WATER_ML_PER_KG = 33.0
_WATER_ACTIVITY_BUMP_ML = {
    "sedentary": 0,
    "light": 0,
    "moderate": 250,
    "active": 500,
    "very_active": 750,
}
_STEP_GOAL_BY_ACTIVITY = {
    "sedentary": 6000,
    "light": 7500,
    "moderate": 9000,
    "active": 10000,
    "very_active": 12000,
}


def _profile_for(c, account_id: int) -> dict | None:
    """Just the two fields these goals depend on -- not progress.py's full
    profile row. Returns None if this account hasn't synced a profile yet
    (brand new account, or onboarding not completed on this device)."""
    row = c.execute(
        "SELECT weight_kg, activity FROM profiles WHERE account_id=?",
        (account_id,),
    ).fetchone()
    return dict(row) if row else None


def _water_goal_ml(profile: dict | None) -> int:
    if not profile:
        return DEFAULT_WATER_GOAL_ML
    bump = _WATER_ACTIVITY_BUMP_ML.get(profile["activity"], 0)
    base = profile["weight_kg"] * _WATER_ML_PER_KG + bump
    return int(min(5000, max(1500, round(base / 50) * 50)))


def _step_goal(profile: dict | None) -> int:
    if not profile:
        return DEFAULT_STEP_GOAL
    return _STEP_GOAL_BY_ACTIVITY.get(profile["activity"], DEFAULT_STEP_GOAL)


def init_db() -> None:
    with db.connect() as c:
        # One row per account/date; `ml` is the running total for that day so a
        # read is a single lookup (no SUM over many rows).
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS water_logs (
                account_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                ml         REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL,
                PRIMARY KEY (account_id, date)
            )
            """
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS habit_logs (
                account_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                kind       TEXT NOT NULL,
                value      REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL,
                PRIMARY KEY (account_id, date, kind)
            )
            """
        )


# --- water ---------------------------------------------------------------- #

class WaterBody(BaseModel):
    date: str = Field(..., min_length=10, max_length=10)  # "YYYY-MM-DD"
    # Positive to add a glass, negative to undo one. Bounded so a bad client
    # can't write an absurd value in a single call.
    ml: float = Field(..., ge=-5000, le=5000)


def _get_water_ml(c, account_id: int, date_key: str) -> float:
    row = c.execute(
        "SELECT ml FROM water_logs WHERE account_id=? AND date=?",
        (account_id, date_key),
    ).fetchone()
    return float(row["ml"]) if row else 0.0


@router.get("/water")
def get_water(request: Request, date: str):
    acct = auth.require_account(request)
    with db.connect() as c:
        ml = _get_water_ml(c, acct["id"], date)
        goal_ml = _water_goal_ml(_profile_for(c, acct["id"]))
    return {"date": date, "ml": ml, "goalMl": goal_ml}


@router.post("/water")
def add_water(body: WaterBody, request: Request):
    acct = auth.require_account(request)
    now = time.time()
    with db.write_lock(), db.connect() as c:
        current = _get_water_ml(c, acct["id"], body.date)
        # Never let the daily total go negative (undoing past zero is a no-op).
        new_ml = max(0.0, current + body.ml)
        c.execute(
            """
            INSERT INTO water_logs (account_id, date, ml, updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(account_id, date) DO UPDATE SET
                ml=excluded.ml, updated_at=excluded.updated_at
            """,
            (acct["id"], body.date, new_ml, now),
        )
        goal_ml = _water_goal_ml(_profile_for(c, acct["id"]))
    return {"date": body.date, "ml": new_ml, "goalMl": goal_ml}


# --- habits --------------------------------------------------------------- #

class HabitBody(BaseModel):
    date: str = Field(..., min_length=10, max_length=10)
    kind: str = Field(..., min_length=1, max_length=32)
    value: float = Field(..., ge=0, le=1_000_000)


def _habits_for(c, account_id: int, date_key: str) -> dict:
    rows = c.execute(
        "SELECT kind, value FROM habit_logs WHERE account_id=? AND date=?",
        (account_id, date_key),
    ).fetchall()
    return {r["kind"]: r["value"] for r in rows}


@router.get("/habits")
def get_habits(request: Request, date: str):
    acct = auth.require_account(request)
    with db.connect() as c:
        habits = _habits_for(c, acct["id"], date)
        step_goal = _step_goal(_profile_for(c, acct["id"]))
    return {"date": date, "habits": habits, "stepGoal": step_goal}


@router.post("/habits")
def set_habit(body: HabitBody, request: Request):
    acct = auth.require_account(request)
    if body.kind not in HABIT_KINDS:
        raise HTTPException(status_code=400, detail=f"Unknown habit '{body.kind}'.")
    now = time.time()
    with db.write_lock(), db.connect() as c:
        # A habit is an absolute value for the day (e.g. "8000 steps"), so this
        # upserts rather than accumulating like water does.
        c.execute(
            """
            INSERT INTO habit_logs (account_id, date, kind, value, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(account_id, date, kind) DO UPDATE SET
                value=excluded.value, updated_at=excluded.updated_at
            """,
            (acct["id"], body.date, body.kind, body.value, now),
        )
        habits = _habits_for(c, acct["id"], body.date)
        step_goal = _step_goal(_profile_for(c, acct["id"]))
    return {"date": body.date, "habits": habits, "stepGoal": step_goal}
