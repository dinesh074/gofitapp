"""
gofit.today — community backend (real, persisted).

A lightweight social layer backed by SQLite. Identity is device-based (a random
id the app generates and stores) — no passwords needed for the MVP.

Endpoints (mounted under /community):
  POST /community/sync                 upsert my {name, kcal, streak}
  GET  /community/groups?device_id=    groups + member counts + joined flag
  POST /community/groups/{gid}/join    join a group
  POST /community/groups/{gid}/leave   leave a group
  GET  /community/leaderboard          top users by streak (+ requester)
  GET  /community/challenges           active challenges
"""
import os
import io
import time
import uuid
import logging
import sqlite3
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from PIL import Image

import auth
import db
import blob_storage

from datetime import date, timedelta

log = logging.getLogger("gofit.community")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "community.db")
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
# Shared write lock (serializes SQLite writers; no-op on Postgres).
_lock = db.write_lock()

router = APIRouter(prefix="/community", tags=["community"])


SEED_GROUPS = [
    ("veg-warriors", "🥗", "Veg Warriors", "Plant-forward Indian eating", 0),
    ("highprotein", "💪", "High-Protein India", "Hit your protein with desi food", 0),
    ("weightloss", "🔥", "Fat-Loss Journey", "Sustainable deficits, together", 0),
    ("diabetes", "🩺", "Sugar-Smart", "Low-GI meals & tips", 0),
    ("southindian", "🍛", "South Indian Foodies", "Idli, dosa, sambar & macros", 0),
]

# NOTE: these are static, hand-written challenge definitions with a fixed
# starting "progress" value — not a live stat computed from real users. That's
# fine for a small, fixed set of challenges the team curates, but if this ever
# grows or `progress` starts being shown as "X% of members completed this",
# make it a real query instead of a hardcoded number.
SEED_CHALLENGES = [
    ("c1", "📸", "7-Day Log Streak", "Log at least 1 meal daily", 0.0, 7),
    ("c2", "🥑", "Protein Push", "Hit protein goal 5 days", 0.0, 5),
    ("c3", "🚫", "No-Fried Fortnight", "Skip deep-fried for 14 days", 0.0, 14),
]

# Previously this file also seeded fake "peer" users (Ananya, Rohit, Meera,
# Karan, Divya) directly into the leaderboard, plus two posts written in their
# voice, so a brand-new install would look like it already had an active
# community. That's fabricated social proof indistinguishable from real
# people to an end user — removed. The leaderboard and feed now start
# genuinely empty and only ever show real accounts' real activity.


def _conn():
    return db.connect()


def init_db() -> None:
    with _lock, _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                device_id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT 'You',
                kcal INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0,
                avatar TEXT NOT NULL DEFAULT '🫵',
                updated_at REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                emoji TEXT NOT NULL,
                name TEXT NOT NULL,
                descr TEXT NOT NULL,
                base_members INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS memberships (
                device_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                PRIMARY KEY (device_id, group_id)
            );
            CREATE TABLE IF NOT EXISTS challenges (
                id TEXT PRIMARY KEY,
                emoji TEXT NOT NULL,
                title TEXT NOT NULL,
                descr TEXT NOT NULL,
                progress REAL NOT NULL,
                days_left INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_avatar TEXT NOT NULL DEFAULT '🫵',
                text TEXT NOT NULL DEFAULT '',
                dish TEXT,
                kcal INTEGER,
                protein_g REAL,
                carbs_g REAL,
                fat_g REAL,
                image_url TEXT,
                created_at REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                PRIMARY KEY (post_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS post_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                author_id TEXT NOT NULL,
                author_name TEXT NOT NULL,
                author_avatar TEXT NOT NULL DEFAULT '🫵',
                text TEXT NOT NULL,
                created_at REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                actor_name TEXT NOT NULL,
                actor_avatar TEXT NOT NULL DEFAULT '🫵',
                kind TEXT NOT NULL,
                post_id INTEGER,
                preview TEXT NOT NULL DEFAULT '',
                is_read INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL DEFAULT 0
            );
            """
        )
        # Migration: add image_url to posts tables created before this column existed.
        cols = db.table_columns(c, "posts")
        if "image_url" not in cols:
            c.execute("ALTER TABLE posts ADD COLUMN image_url TEXT")
        # Indexes for feed ordering, per-post like/comment lookups, membership
        # counts and notification queries — required to stay fast under load.
        for stmt in (
            "CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id)",
            "CREATE INDEX IF NOT EXISTS idx_memberships_group ON memberships(group_id)",
            "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)",
        ):
            c.execute(stmt)
        for g in SEED_GROUPS:
            c.execute(
                "INSERT OR IGNORE INTO groups (id, emoji, name, descr, base_members) VALUES (?,?,?,?,?)",
                g,
            )
        for ch in SEED_CHALLENGES:
            c.execute(
                "INSERT OR IGNORE INTO challenges (id, emoji, title, descr, progress, days_left) VALUES (?,?,?,?,?,?)",
                ch,
            )
        # No fake peers, no fake posts. See the note above SEED_CHALLENGES.


class SyncBody(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=128)
    name: str = Field("You", max_length=40)
    kcal: int = Field(0, ge=0, le=100000)
    streak: int = Field(0, ge=0, le=100000)
    avatar: str = Field("", max_length=512)


def _member_count(c: sqlite3.Connection, group_id: str, base: int) -> int:
    """Real membership count only. `base` is accepted for schema compatibility
    (SEED_GROUPS still carries the column) but is no longer added on top — it
    used to inflate every group's displayed count with a fabricated starting
    number that never went away. Groups now honestly show 0 until real people
    join."""
    n = c.execute(
        "SELECT COUNT(*) AS n FROM memberships WHERE group_id=?", (group_id,)
    ).fetchone()["n"]
    return n


def _real_kcal_streak(account_id: int) -> tuple:
    """Today's kcal total and the current logging streak, computed directly
    from meal_logs (backend/progress.py) -- the real table -- rather than
    trusting whatever numbers the client happens to send. Mirrors app/
    storage.ts's computeStreak(): the streak holds if today has nothing
    logged yet but yesterday did, same "haven't broken it yet today" rule
    the app itself uses."""
    with db.connect() as c:
        rows = c.execute(
            "SELECT date, kcal FROM meal_logs WHERE account_id=?", (account_id,)
        ).fetchall()
    by_day: dict = {}
    for r in rows:
        by_day[r["date"]] = by_day.get(r["date"], 0) + (r["kcal"] or 0)

    today = date.today()
    kcal_today = int(round(by_day.get(today.isoformat(), 0)))

    d = today
    if by_day.get(d.isoformat(), 0) <= 0:
        d = d - timedelta(days=1)
    streak = 0
    while by_day.get(d.isoformat(), 0) > 0:
        streak += 1
        d = d - timedelta(days=1)
    return kcal_today, streak


@router.post("/sync")
def sync(body: SyncBody, request: Request):
    # If the caller has a valid Bearer token, their real account identity
    # ALWAYS wins over whatever device_id the client sent -- otherwise anyone
    # could overwrite a real signed-in account's community stats just by
    # sending its acct-<id> in the body, no proof required. Purely anonymous
    # (no account) callers still write under their own client-chosen device_id,
    # same as before -- that's an accepted, low-stakes tradeoff of not
    # requiring login for anonymous use, not an oversight.
    target_id = _requester_id(request, body.device_id)
    if not target_id:
        raise HTTPException(status_code=400, detail="device_id required")
    name = body.name.strip() or "You"
    avatar = (body.avatar or "").strip()

    # A signed-in account now has a real source of truth for kcal/streak
    # (meal_logs) -- use that instead of the client-reported numbers, which
    # could drift out of sync or be spoofed. Anonymous/no-account callers
    # have no such server-side history to compute from, so their
    # self-reported numbers remain the only option -- same low-stakes
    # tradeoff noted above.
    account_id = auth.account_id_from_community(target_id)
    if account_id is not None:
        kcal, streak = _real_kcal_streak(account_id)
    else:
        kcal, streak = body.kcal, body.streak

    with _lock, _conn() as c:
        if avatar:
            c.execute(
                """
                INSERT INTO users (device_id, name, kcal, streak, avatar, updated_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(device_id) DO UPDATE SET
                    name=excluded.name, kcal=excluded.kcal,
                    streak=excluded.streak, avatar=excluded.avatar,
                    updated_at=excluded.updated_at
                """,
                (target_id, name, kcal, streak, avatar, time.time()),
            )
        else:
            c.execute(
                """
                INSERT INTO users (device_id, name, kcal, streak, updated_at)
                VALUES (?,?,?,?,?)
                ON CONFLICT(device_id) DO UPDATE SET
                    name=excluded.name, kcal=excluded.kcal,
                    streak=excluded.streak, updated_at=excluded.updated_at
                """,
                (target_id, name, kcal, streak, time.time()),
            )
    return {"ok": True}


@router.get("/groups")
def groups(device_id: str = ""):
    with _lock, _conn() as c:
        joined = {
            r["group_id"]
            for r in c.execute(
                "SELECT group_id FROM memberships WHERE device_id=?", (device_id,)
            ).fetchall()
        }
        out = []
        for g in c.execute("SELECT * FROM groups").fetchall():
            out.append(
                {
                    "id": g["id"],
                    "emoji": g["emoji"],
                    "name": g["name"],
                    "desc": g["descr"],
                    "members": _member_count(c, g["id"], g["base_members"]),
                    "joined": g["id"] in joined,
                }
            )
    return {"groups": out}


@router.post("/groups/{gid}/join")
def join(gid: str, request: Request, device_id: str = ""):
    # See sync()'s comment -- an authenticated caller's real identity always
    # wins over a client-supplied device_id, so this can't be used to join
    # groups on behalf of an account that isn't yours.
    target_id = _requester_id(request, device_id)
    if not target_id:
        raise HTTPException(status_code=400, detail="device_id required")
    with _lock, _conn() as c:
        exists = c.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="No such group")
        c.execute(
            "INSERT OR IGNORE INTO memberships (device_id, group_id) VALUES (?,?)",
            (target_id, gid),
        )
    return {"ok": True, "joined": True}


@router.post("/groups/{gid}/leave")
def leave(gid: str, request: Request, device_id: str = ""):
    target_id = _requester_id(request, device_id)
    if not target_id:
        raise HTTPException(status_code=400, detail="device_id required")
    with _lock, _conn() as c:
        c.execute(
            "DELETE FROM memberships WHERE device_id=? AND group_id=?", (target_id, gid)
        )
    return {"ok": True, "joined": False}


@router.get("/leaderboard")
def leaderboard(device_id: str = "", limit: int = 20):
    limit = max(1, min(limit, 100))
    with _lock, _conn() as c:
        rows = c.execute(
            """
            SELECT device_id, name, kcal, streak, avatar FROM users
            ORDER BY streak DESC, kcal ASC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        board = [
            {
                "device_id": r["device_id"],
                "name": r["name"],
                "kcal": r["kcal"],
                "streak": r["streak"],
                "avatar": r["avatar"],
                "isMe": r["device_id"] == device_id,
            }
            for r in rows
        ]
        # Ensure the requester appears even if outside the top N.
        if device_id and not any(b["isMe"] for b in board):
            me = c.execute(
                "SELECT device_id, name, kcal, streak, avatar FROM users WHERE device_id=?",
                (device_id,),
            ).fetchone()
            if me:
                board.append(
                    {
                        "device_id": me["device_id"],
                        "name": me["name"],
                        "kcal": me["kcal"],
                        "streak": me["streak"],
                        "avatar": me["avatar"],
                        "isMe": True,
                    }
                )
    return {"leaderboard": board}


@router.get("/challenges")
def challenges():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM challenges").fetchall()
        out = [
            {
                "id": r["id"],
                "emoji": r["emoji"],
                "title": r["title"],
                "desc": r["descr"],
                "progress": r["progress"],
                "daysLeft": r["days_left"],
            }
            for r in rows
        ]
    return {"challenges": out}


# ------------------------------- Social feed --------------------------------

class MealSnap(BaseModel):
    dish: str = Field(..., max_length=80)
    kcal: int = Field(0, ge=0, le=100000)
    protein_g: float = Field(0, ge=0, le=10000)
    carbs_g: float = Field(0, ge=0, le=10000)
    fat_g: float = Field(0, ge=0, le=10000)


class PostBody(BaseModel):
    text: str = Field("", max_length=500)
    meal: Optional[MealSnap] = None
    image_url: Optional[str] = Field(None, max_length=200)


class CommentBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=300)


def _requester_id(request: Request, device_id: str = "") -> str:
    """A signed-in account takes precedence; otherwise fall back to device id."""
    acct = auth.account_from_request(request)
    return acct["communityId"] if acct else device_id


def _post_row(c: sqlite3.Connection, r: sqlite3.Row, me: str) -> dict:
    likes = c.execute(
        "SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?", (r["id"],)
    ).fetchone()["n"]
    comments = c.execute(
        "SELECT COUNT(*) AS n FROM post_comments WHERE post_id=?", (r["id"],)
    ).fetchone()["n"]
    liked = False
    if me:
        liked = (
            c.execute(
                "SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?",
                (r["id"], me),
            ).fetchone()
            is not None
        )
    meal = None
    if r["dish"]:
        meal = {
            "dish": r["dish"],
            "kcal": r["kcal"] or 0,
            "protein_g": r["protein_g"] or 0,
            "carbs_g": r["carbs_g"] or 0,
            "fat_g": r["fat_g"] or 0,
        }
    return {
        "id": r["id"],
        "author_id": r["author_id"],
        "author_name": r["author_name"],
        "author_avatar": r["author_avatar"],
        "text": r["text"],
        "meal": meal,
        "image": r["image_url"],
        "likes": likes,
        "comments": comments,
        "liked": liked,
        "mine": bool(me) and r["author_id"] == me,
        "created_at": r["created_at"],
    }


def _notify(
    c: sqlite3.Connection,
    post_id: int,
    author_id: str,
    actor: dict,
    kind: str,
    preview: str = "",
) -> None:
    """Record a like/comment notification for the post's author.

    No-op when the actor is the author (you don't get pinged for your own
    actions)."""
    if author_id == actor["communityId"]:
        return
    c.execute(
        """INSERT INTO notifications
           (user_id, actor_id, actor_name, actor_avatar, kind, post_id, preview, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            author_id,
            actor["communityId"],
            actor["name"],
            actor["avatar"],
            kind,
            post_id,
            preview[:120],
            time.time(),
        ),
    )
    # Fire a remote push to the recipient's devices (best-effort, non-blocking).
    recipient_id = auth.account_id_from_community(author_id)
    if recipient_id is not None:
        if kind == "like":
            title = "New like \u2764\ufe0f"
            msg = f"{actor['name']} liked your post"
        else:
            title = "New comment \U0001f4ac"
            msg = (
                f"{actor['name']} commented: {preview[:80]}"
                if preview
                else f"{actor['name']} commented on your post"
            )
        auth.send_push(recipient_id, title, msg, {"type": kind, "postId": post_id})


@router.get("/feed")
def feed(request: Request, device_id: str = "", limit: int = 30):
    limit = max(1, min(limit, 100))
    me = _requester_id(request, device_id)
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM posts ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        out = [_post_row(c, r, me) for r in rows]
    return {"feed": out}


@router.post("/posts")
def create_post(body: PostBody, request: Request):
    acct = auth.require_account(request)
    text = body.text.strip()
    image_url = (body.image_url or "").strip() or None
    # Only accept image paths we produced ourselves (prevents storing arbitrary URLs).
    if image_url and not image_url.startswith("/community/images/"):
        raise HTTPException(status_code=400, detail="Invalid image reference")
    if not text and not body.meal and not image_url:
        raise HTTPException(status_code=400, detail="Add a photo, a meal, or some text")
    m = body.meal
    with _lock, _conn() as c:
        cur = c.execute(
            """INSERT INTO posts (author_id, author_name, author_avatar, text,
               dish, kcal, protein_g, carbs_g, fat_g, image_url, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                acct["communityId"],
                acct["name"],
                acct["avatar"],
                text,
                m.dish if m else None,
                m.kcal if m else None,
                m.protein_g if m else None,
                m.carbs_g if m else None,
                m.fat_g if m else None,
                image_url,
                time.time(),
            ),
        )
        row = c.execute("SELECT * FROM posts WHERE id=?", (cur.lastrowid,)).fetchone()
        post = _post_row(c, row, acct["communityId"])
    return {"post": post}


@router.delete("/posts/{pid}")
def delete_post(pid: int, request: Request):
    acct = auth.require_account(request)
    with _lock, _conn() as c:
        row = c.execute("SELECT author_id FROM posts WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Post not found")
        if row["author_id"] != acct["communityId"]:
            raise HTTPException(status_code=403, detail="You can only delete your own posts")
        c.execute("DELETE FROM posts WHERE id=?", (pid,))
        c.execute("DELETE FROM post_likes WHERE post_id=?", (pid,))
        c.execute("DELETE FROM post_comments WHERE post_id=?", (pid,))
        c.execute("DELETE FROM notifications WHERE post_id=?", (pid,))
    return {"ok": True}


@router.post("/posts/{pid}/like")
def like_post(pid: int, request: Request):
    acct = auth.require_account(request)
    with _lock, _conn() as c:
        post = c.execute(
            "SELECT author_id FROM posts WHERE id=?", (pid,)
        ).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="Post not found")
        cur = c.execute(
            "INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?,?)",
            (pid, acct["communityId"]),
        )
        # Only notify on a genuinely new like (rowcount == 1), not a repeat.
        if cur.rowcount:
            _notify(c, pid, post["author_id"], acct, "like")
        n = c.execute(
            "SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?", (pid,)
        ).fetchone()["n"]
    return {"ok": True, "liked": True, "likes": n}


@router.post("/posts/{pid}/unlike")
def unlike_post(pid: int, request: Request):
    acct = auth.require_account(request)
    with _lock, _conn() as c:
        c.execute(
            "DELETE FROM post_likes WHERE post_id=? AND user_id=?",
            (pid, acct["communityId"]),
        )
        n = c.execute(
            "SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?", (pid,)
        ).fetchone()["n"]
    return {"ok": True, "liked": False, "likes": n}


@router.get("/posts/{pid}/comments")
def get_comments(pid: int):
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM post_comments WHERE post_id=? ORDER BY created_at ASC",
            (pid,),
        ).fetchall()
        out = [
            {
                "id": r["id"],
                "author_name": r["author_name"],
                "author_avatar": r["author_avatar"],
                "text": r["text"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    return {"comments": out}


@router.post("/posts/{pid}/comments")
def add_comment(pid: int, body: CommentBody, request: Request):
    acct = auth.require_account(request)
    text = body.text.strip()
    with _lock, _conn() as c:
        post = c.execute(
            "SELECT author_id FROM posts WHERE id=?", (pid,)
        ).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="Post not found")
        cur = c.execute(
            """INSERT INTO post_comments (post_id, author_id, author_name, author_avatar, text, created_at)
               VALUES (?,?,?,?,?,?)""",
            (
                pid,
                acct["communityId"],
                acct["name"],
                acct["avatar"],
                text,
                time.time(),
            ),
        )
        _notify(c, pid, post["author_id"], acct, "comment", text)
        row = c.execute(
            "SELECT * FROM post_comments WHERE id=?", (cur.lastrowid,)
        ).fetchone()
    return {
        "comment": {
            "id": row["id"],
            "author_name": row["author_name"],
            "author_avatar": row["author_avatar"],
            "text": row["text"],
            "created_at": row["created_at"],
        }
    }


# ---------------------------- User profile pages ----------------------------

@router.get("/users/{author_id}")
def user_profile(author_id: str, request: Request, device_id: str = ""):
    me = _requester_id(request, device_id)
    with _lock, _conn() as c:
        u = c.execute(
            "SELECT device_id, name, kcal, streak, avatar FROM users WHERE device_id=?",
            (author_id,),
        ).fetchone()
        # A user may have posted before syncing stats — derive identity from posts.
        if not u:
            p = c.execute(
                "SELECT author_name, author_avatar FROM posts WHERE author_id=? LIMIT 1",
                (author_id,),
            ).fetchone()
            if not p:
                raise HTTPException(status_code=404, detail="User not found")
            profile = {
                "id": author_id,
                "name": p["author_name"],
                "avatar": p["author_avatar"],
                "streak": 0,
                "kcal": 0,
            }
        else:
            profile = {
                "id": u["device_id"],
                "name": u["name"],
                "avatar": u["avatar"],
                "streak": u["streak"],
                "kcal": u["kcal"],
            }
        rows = c.execute(
            "SELECT * FROM posts WHERE author_id=? ORDER BY created_at DESC LIMIT 50",
            (author_id,),
        ).fetchall()
        posts = [_post_row(c, r, me) for r in rows]
        post_count = c.execute(
            "SELECT COUNT(*) AS n FROM posts WHERE author_id=?", (author_id,)
        ).fetchone()["n"]
    profile["posts"] = post_count
    profile["isMe"] = bool(me) and author_id == me
    return {"profile": profile, "feed": posts}


# ------------------------------ Notifications -------------------------------

@router.get("/notifications")
def notifications(request: Request, limit: int = 40):
    acct = auth.require_account(request)
    limit = max(1, min(limit, 100))
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (acct["communityId"], limit),
        ).fetchall()
        items = [
            {
                "id": r["id"],
                "actor_id": r["actor_id"],
                "actor_name": r["actor_name"],
                "actor_avatar": r["actor_avatar"],
                "kind": r["kind"],
                "post_id": r["post_id"],
                "preview": r["preview"],
                "read": bool(r["is_read"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        unread = c.execute(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND is_read=0",
            (acct["communityId"],),
        ).fetchone()["n"]
    return {"notifications": items, "unread": unread}


@router.post("/notifications/read")
def mark_notifications_read(request: Request):
    acct = auth.require_account(request)
    with _lock, _conn() as c:
        c.execute(
            "UPDATE notifications SET is_read=1 WHERE user_id=?",
            (acct["communityId"],),
        )
    return {"ok": True}


# --------------------------------- Images -----------------------------------

MAX_IMAGE_BYTES = 8 * 1024 * 1024


@router.post("/upload")
async def upload_image(request: Request, file: UploadFile = File(...)):
    auth.require_account(request)
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="File must be an image")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8MB)")
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((1080, 1080))  # cap size to keep storage/bandwidth sane
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or unreadable image")
    name = uuid.uuid4().hex + ".jpg"
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    jpeg_bytes = buf.getvalue()

    # Prefer real object storage (Supabase's `community-photos` bucket) --
    # local disk isn't durable on most hosting platforms (see DEPLOY.md).
    # Falls back to local disk if Storage isn't configured yet, or if the
    # upload call itself fails, so one storage hiccup doesn't 500 the post.
    if blob_storage.configured():
        try:
            public_url = blob_storage.upload_community_photo(name, jpeg_bytes)
            return {"image_url": public_url}
        except Exception as ex:
            log.warning("Supabase Storage upload failed, falling back to local disk: %s", ex)

    with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
        f.write(jpeg_bytes)
    return {"image_url": f"/community/images/{name}"}


@router.get("/images/{name}")
def get_image(name: str):
    # Guard against path traversal — only serve plain filenames.
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Bad name")
    path = os.path.join(UPLOAD_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="image/jpeg")
