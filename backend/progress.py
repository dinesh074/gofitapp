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
  GET  /profile          -> {profile: {...} | null}
  PUT  /profile          -> upsert the caller's profile
  GET  /logs             -> {logs: {"YYYY-MM-DD": {date, meals: [...]}}}
  POST /logs             -> append one meal to a date, returns its id
  DELETE /logs/{id}      -> remove one meal (must belong to the caller)
  GET  /weights          -> {weights: [{kg, at}, ...]}
  POST /weights          -> append one weight check-in
"""
import time
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
import auth

log = logging.getLogger("gofit.progress")

router = APIRouter(tags=["progress"])


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
                created_at       REAL NOT NULL,
                updated_at       REAL NOT NULL
            )
            """
        )
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
        "createdAt": row["created_at"],
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
                 target_weight_kg, goal, activity, diet, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
                name=excluded.name, gender=excluded.gender, age=excluded.age,
                height_cm=excluded.height_cm, weight_kg=excluded.weight_kg,
                target_weight_kg=excluded.target_weight_kg, goal=excluded.goal,
                activity=excluded.activity, diet=excluded.diet,
                updated_at=excluded.updated_at
            """,
            (
                acct["id"], body.name, body.gender, body.age, body.heightCm,
                body.weightKg, body.targetWeightKg, body.goal, body.activity,
                body.diet, created_at, now,
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


@router.get("/logs")
def get_logs(request: Request):
    acct = auth.require_account(request)
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM meal_logs WHERE account_id=? ORDER BY at ASC",
            (acct["id"],),
        ).fetchall()
    logs: dict = {}
    for r in rows:
        d = r["date"]
        if d not in logs:
            logs[d] = {"date": d, "meals": []}
        logs[d]["meals"].append(
            {
                "id": r["id"],
                "dish": r["dish"],
                "kcal": r["kcal"],
                "protein_g": r["protein_g"],
                "carbs_g": r["carbs_g"],
                "fat_g": r["fat_g"],
                "at": r["at"],
            }
        )
    return {"logs": logs}


@router.post("/logs")
def add_log(body: MealBody, request: Request):
    acct = auth.require_account(request)
    at = time.time()
    with db.write_lock(), db.connect() as c:
        cur = c.execute(
            "INSERT INTO meal_logs (account_id, date, dish, kcal, protein_g, carbs_g, fat_g, at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (acct["id"], body.date, body.dish, body.kcal, body.protein_g, body.carbs_g, body.fat_g, at),
        )
        new_id = cur.lastrowid
    return {"ok": True, "id": new_id, "at": at}


@router.delete("/logs/{log_id}")
def delete_log(log_id: int, request: Request):
    acct = auth.require_account(request)
    with db.write_lock(), db.connect() as c:
        row = c.execute("SELECT account_id FROM meal_logs WHERE id=?", (log_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        if row["account_id"] != acct["id"]:
            # Same principle as community.py's _requester_id -- never let a
            # caller act on another account's rows just because they guessed
            # an id.
            raise HTTPException(status_code=404, detail="Not found")
        c.execute("DELETE FROM meal_logs WHERE id=?", (log_id,))
    return {"ok": True}


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
