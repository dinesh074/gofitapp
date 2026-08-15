"""
gofit.today — accounts & authentication (Google-only).

Accounts are created and restored exclusively through Google Sign-In. We verify
the Google ID token, dedupe by the Google subject id (falling back to email),
and mint an opaque bearer
token stored server-side; the client sends it as `Authorization: Bearer <token>`.

An account's community identity is the string `acct-<id>`. Signing in on a new
device therefore restores the same leaderboard/feed identity.

Endpoints (mounted under /auth):
  POST /auth/google              {id_token}                 -> {token, account}
  POST /auth/otp/request         {email}                    -> {ok, sent}
  POST /auth/otp/verify          {email, code}              -> {token, account}
  GET  /auth/me                 (Bearer)                   -> {account}
  POST /auth/logout              (Bearer)                   -> {ok}
  POST /auth/upgrade             (Bearer)                   -> {account}   (Pro stub)
  POST /auth/push-token          (Bearer) {token, platform} -> {ok}
  GET  /auth/devices             (Bearer)                   -> {devices: [...]} -- this
                                  account's sessions (platform/app version/last-active),
                                  never exposes the real bearer tokens.
  GET  /auth/notification-prefs  (Bearer)                   -> {prefs}
  PUT  /auth/notification-prefs  (Bearer) {push_likes, push_comments, push_community}
"""
import os
import re
import json
import time
import hmac
import hashlib
import secrets
import sqlite3
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import db
import audit
import email_service

# Serializes writes on SQLite; a no-op on Postgres (which is concurrency-safe).
# Shared across modules via db so SQLite writers never collide.
_lock = db.write_lock()

router = APIRouter(prefix="/auth", tags=["auth"])

_PBKDF_ROUNDS = 120_000

# Free-trial: this many food scans per account, then the paywall kicks in.
FREE_SCANS = int(os.environ.get("FREE_SCANS", "3"))

# TEST MODE: when enabled, POST /auth/dev issues a token for a shared "Tester"
# account with NO Google sign-in. Lets us exercise the whole app while Google
# OAuth is still being configured. MUST stay off in production.
ALLOW_DEV_LOGIN = os.environ.get("ALLOW_DEV_LOGIN", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# Temporary kill-switch for email OTP login. Keep default OFF in production
# until mail delivery is fully stable.
ENABLE_OTP_LOGIN = os.environ.get("ENABLE_OTP_LOGIN", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# Google OAuth client id used to validate ID tokens. Leave blank in dev (the
# scaffold still verifies the token signature; audience check is skipped).
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()


def _conn():
    return db.connect()


def init_db() -> None:
    with _lock, _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL DEFAULT 'You',
                avatar TEXT NOT NULL DEFAULT '🫵',
                pw_hash TEXT NOT NULL,
                pw_salt TEXT NOT NULL,
                created_at REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                created_at REAL NOT NULL DEFAULT 0
            );
            """
        )
        _migrate(c)


def _migrate(c: sqlite3.Connection) -> None:
    """Additive columns for Google login + the free-scan trial. Safe to re-run."""
    cols = db.table_columns(c, "accounts")
    add = []
    if "google_sub" not in cols:
        add.append("ALTER TABLE accounts ADD COLUMN google_sub TEXT")
    if "email" not in cols:
        add.append("ALTER TABLE accounts ADD COLUMN email TEXT")
    if "is_pro" not in cols:
        add.append("ALTER TABLE accounts ADD COLUMN is_pro INTEGER NOT NULL DEFAULT 0")
    if "scans_used" not in cols:
        add.append("ALTER TABLE accounts ADD COLUMN scans_used INTEGER NOT NULL DEFAULT 0")
    for stmt in add:
        c.execute(stmt)
    # Expo push tokens (one row per device); used to deliver remote push for
    # community likes/comments. Keyed by token so the same device upserts.
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS push_tokens (
            token TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL,
            platform TEXT NOT NULL DEFAULT '',
            updated_at REAL NOT NULL DEFAULT 0
        )
        """
    )
    # pw_hash/pw_salt are NOT NULL; Google-only accounts have no password, so
    # they store empty strings there. Nothing else to migrate.

    # One row per issued session token -- which device/platform/app version
    # it belongs to, and when it was last actually used. Lets an account see
    # "signed in on 3 devices" instead of that only being visible by querying
    # the tokens table directly, and gives us real diagnostic data instead of
    # guessing when a user reports a device-specific bug.
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS devices (
            token TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL,
            platform TEXT,
            app_version TEXT,
            created_at REAL NOT NULL DEFAULT 0,
            last_active_at REAL NOT NULL DEFAULT 0
        )
        """
    )
    # Per-account push notification preferences. Absent row = defaults (all on).
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS notification_prefs (
            account_id INTEGER PRIMARY KEY,
            push_likes INTEGER NOT NULL DEFAULT 1,
            push_comments INTEGER NOT NULL DEFAULT 1,
            push_community INTEGER NOT NULL DEFAULT 1,
            updated_at REAL NOT NULL DEFAULT 0
        )
        """
    )

    # One-time email sign-in codes (an alternative to Google Sign-In). A row is
    # created per /auth/otp/request call; consumed (attempts incremented, or
    # deleted on success) by /auth/otp/verify. Short-lived by design.
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS otp_codes (
            email TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL DEFAULT 0,
            expires_at REAL NOT NULL DEFAULT 0
        )
        """
    )

    # Indexes for the hot lookup paths (login dedupe + per-request token auth +
    # push fan-out). Without these Postgres does sequential scans that fall over
    # under load.
    for stmt in (
        "CREATE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub)",
        "CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email)",
        "CREATE INDEX IF NOT EXISTS idx_tokens_account ON tokens(account_id)",
        "CREATE INDEX IF NOT EXISTS idx_push_tokens_account ON push_tokens(account_id)",
        "CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id)",
    ):
        c.execute(stmt)


# --- password helpers --------------------------------------------------------

def _hash_password(password: str, salt: str) -> str:
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), _PBKDF_ROUNDS
    )
    return dk.hex()


def _verify_password(password: str, salt: str, expected: str) -> bool:
    return hmac.compare_digest(_hash_password(password, salt), expected)


def _norm_username(u: str) -> str:
    return u.strip().lower()


def _community_id(account_id: int) -> str:
    return f"acct-{account_id}"


def _account_public(row: sqlite3.Row) -> dict:
    keys = row.keys()
    is_pro = bool(row["is_pro"]) if "is_pro" in keys else False
    scans_used = row["scans_used"] if "scans_used" in keys else 0
    return {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
        "avatar": row["avatar"],
        "communityId": _community_id(row["id"]),
        "isPro": is_pro,
        "scansUsed": scans_used,
        "scansLimit": FREE_SCANS,
        "scansLeft": max(0, FREE_SCANS - scans_used) if not is_pro else None,
    }


# --- free-trial usage (importable by main.py analyze) ------------------------
def usage_for(account_id: int) -> dict:
    """Return {is_pro, scans_used, scans_limit, allowed}."""
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT is_pro, scans_used FROM accounts WHERE id=?", (account_id,)
        ).fetchone()
    if not row:
        return {"is_pro": False, "scans_used": 0, "scans_limit": FREE_SCANS, "allowed": False}
    is_pro = bool(row["is_pro"])
    used = row["scans_used"]
    return {
        "is_pro": is_pro,
        "scans_used": used,
        "scans_limit": FREE_SCANS,
        "allowed": is_pro or used < FREE_SCANS,
    }


def consume_scan(account_id: int) -> None:
    """Increment the account's scan counter (call only after a successful scan).
    The `scans_used < FREE_SCANS` guard makes the COUNTER cap-safe under
    concurrency -- but see reserve_scan()/release_scan() below for why that
    alone doesn't actually enforce the free-scan limit. Kept for any other
    caller; /analyze uses reserve_scan()+release_scan() instead."""
    with _lock, _conn() as c:
        c.execute(
            "UPDATE accounts SET scans_used = scans_used + 1 "
            "WHERE id=? AND is_pro=0 AND scans_used < ?",
            (account_id, FREE_SCANS),
        )


def reserve_scan(account_id: int) -> bool:
    """Atomically check-and-reserve one scan slot BEFORE the slow Gemini call.

    The bug this closes: the old flow called usage_for() (a read) to decide
    whether to proceed, then only called consume_scan() (the write) AFTER a
    successful, several-second Gemini call. consume_scan()'s own WHERE clause
    kept the *counter* from exceeding FREE_SCANS, but that's not the same as
    enforcing the limit -- N concurrent requests could all pass the read
    before any of them recorded a write, so all N would get a real (costly)
    Gemini analysis back, and only afterward would the counter cap at
    FREE_SCANS. The counter looking correct was hiding that the user had
    already received more free results than they were entitled to.

    Fix: fold the check and the increment into ONE atomic UPDATE, run before
    any Gemini call. Pro accounts always succeed (unlimited, uncounted, same
    as before). Returns True if the slot was reserved (or the account is
    Pro), False if the free-scan limit is already reached.
    """
    with _lock, _conn() as c:
        row = c.execute("SELECT is_pro FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            return False
        if row["is_pro"]:
            return True
        cur = c.execute(
            "UPDATE accounts SET scans_used = scans_used + 1 "
            "WHERE id=? AND is_pro=0 AND scans_used < ?",
            (account_id, FREE_SCANS),
        )
        return cur.rowcount > 0


def release_scan(account_id: int) -> None:
    """Refund a slot reserved by reserve_scan() when the analysis itself
    ultimately failed (e.g. Gemini errored after all retries) -- a failed
    request shouldn't cost the user a real scan. No-op for Pro accounts
    (reserve_scan never incremented them)."""
    with _lock, _conn() as c:
        c.execute(
            "UPDATE accounts SET scans_used = scans_used - 1 "
            "WHERE id=? AND is_pro=0 AND scans_used > 0",
            (account_id,),
        )


def set_pro(account_id: int, pro: bool = True) -> Optional[dict]:
    with _lock, _conn() as c:
        c.execute("UPDATE accounts SET is_pro=? WHERE id=?", (1 if pro else 0, account_id))
        row = c.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    return _account_public(row) if row else None


def account_contact(account_id: int) -> dict:
    """Return {name, email} for prefilling the payment checkout (best-effort)."""
    with _conn() as c:
        row = c.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    if not row:
        return {"name": "", "email": ""}
    keys = row.keys()
    return {
        "name": row["name"] or "",
        "email": (row["email"] if "email" in keys else "") or "",
    }


# --- push notifications (Expo) ----------------------------------------------

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

# Bounded worker pool for outbound push delivery so bursts of likes/comments
# can't spawn unbounded threads. Sized via env for larger deployments.
_push_pool = ThreadPoolExecutor(
    max_workers=int(os.environ.get("PUSH_WORKERS", "8")),
    thread_name_prefix="push",
)


def register_push_token(account_id: int, token: str, platform: str = "") -> None:
    """Upsert an Expo push token for a device, re-pointing it to this account."""
    token = (token or "").strip()
    if not token:
        return
    with _lock, _conn() as c:
        c.execute(
            """
            INSERT INTO push_tokens (token, account_id, platform, updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(token) DO UPDATE SET
                account_id=excluded.account_id,
                platform=excluded.platform,
                updated_at=excluded.updated_at
            """,
            (token, account_id, platform or "", time.time()),
        )


def tokens_for_account(account_id: int) -> list:
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT token FROM push_tokens WHERE account_id=?", (account_id,)
        ).fetchall()
    return [r["token"] for r in rows if r["token"]]


def _drop_tokens(tokens: list) -> None:
    if not tokens:
        return
    with _lock, _conn() as c:
        c.executemany("DELETE FROM push_tokens WHERE token=?", [(t,) for t in tokens])


def _post_expo(messages: list) -> None:
    """Deliver a batch of Expo push messages. Best-effort; prunes dead tokens."""
    try:
        data = json.dumps(messages).encode("utf-8")
        req = urllib.request.Request(
            EXPO_PUSH_URL,
            data=data,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return
    # Prune tokens Expo reports as unregistered so we stop pushing to dead devices.
    dead = []
    for msg, receipt in zip(messages, body.get("data", []) or []):
        if isinstance(receipt, dict) and receipt.get("status") == "error":
            if (receipt.get("details") or {}).get("error") == "DeviceNotRegistered":
                dead.append(msg.get("to"))
    _drop_tokens([t for t in dead if t])


def send_push(account_id: int, title: str, body: str, data: Optional[dict] = None) -> None:
    """Send a push to all of an account's devices, off the request thread."""
    tokens = tokens_for_account(account_id)
    if not tokens:
        return
    messages = [
        {
            "to": t,
            "title": title,
            "body": body,
            "sound": "default",
            "data": data or {},
        }
        for t in tokens
    ]
    # Bounded pool: under a like/comment storm this caps concurrent push work
    # instead of spawning an unbounded number of threads (one per event).
    _push_pool.submit(_post_expo, messages)


def account_id_from_community(community_id: str) -> Optional[int]:
    """Reverse of _community_id: 'acct-7' -> 7. Returns None if not an account."""
    if isinstance(community_id, str) and community_id.startswith("acct-"):
        try:
            return int(community_id[5:])
        except ValueError:
            return None
    return None


# --- token resolution (importable by other routers) --------------------------

def account_from_request(request: Request) -> Optional[dict]:
    """Return the public account dict for a valid Bearer token, else None."""
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    with _lock, _conn() as c:
        row = c.execute(
            """
            SELECT a.* FROM tokens t
            JOIN accounts a ON a.id = t.account_id
            WHERE t.token = ?
            """,
            (token,),
        ).fetchone()
    return _account_public(row) if row else None


def require_account(request: Request) -> dict:
    acct = account_from_request(request)
    if not acct:
        raise HTTPException(status_code=401, detail="Please sign in to continue")
    return acct


# --- request bodies ----------------------------------------------------------


def _issue_token(account_id: int, platform: str = "", app_version: str = "") -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO tokens (token, account_id, created_at) VALUES (?,?,?)",
            (token, account_id, now),
        )
        c.execute(
            "INSERT INTO devices (token, account_id, platform, app_version, created_at, last_active_at) "
            "VALUES (?,?,?,?,?,?)",
            (token, account_id, platform or None, app_version or None, now, now),
        )
    return token


def touch_device(token: str) -> None:
    """Best-effort last-active bump. Called on real request traffic, not on
    every single request (see account_from_request) -- device presence is a
    diagnostic aid, not something that needs sub-second precision."""
    try:
        with _lock, _conn() as c:
            c.execute("UPDATE devices SET last_active_at=? WHERE token=?", (time.time(), token))
    except Exception:
        pass


def devices_for_account(account_id: int) -> list:
    with _conn() as c:
        rows = c.execute(
            "SELECT token, platform, app_version, created_at, last_active_at "
            "FROM devices WHERE account_id=? ORDER BY last_active_at DESC",
            (account_id,),
        ).fetchall()
    return [
        {
            # Never expose the real token -- just enough to tell devices
            # apart in a "signed in on these devices" list.
            "id": r["token"][:8],
            "platform": r["platform"],
            "appVersion": r["app_version"],
            "createdAt": r["created_at"],
            "lastActiveAt": r["last_active_at"],
        }
        for r in rows
    ]


def get_notification_prefs(account_id: int) -> dict:
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM notification_prefs WHERE account_id=?", (account_id,)
        ).fetchone()
    if not row:
        return {"pushLikes": True, "pushComments": True, "pushCommunity": True}
    return {
        "pushLikes": bool(row["push_likes"]),
        "pushComments": bool(row["push_comments"]),
        "pushCommunity": bool(row["push_community"]),
    }


def set_notification_prefs(account_id: int, likes: bool, comments: bool, community: bool) -> dict:
    now = time.time()
    with _lock, _conn() as c:
        c.execute(
            """
            INSERT INTO notification_prefs (account_id, push_likes, push_comments, push_community, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
                push_likes=excluded.push_likes, push_comments=excluded.push_comments,
                push_community=excluded.push_community, updated_at=excluded.updated_at
            """,
            (account_id, 1 if likes else 0, 1 if comments else 0, 1 if community else 0, now),
        )
    return {"pushLikes": likes, "pushComments": comments, "pushCommunity": community}


@router.get("/me")
def me(request: Request):
    return {"account": require_account(request)}


@router.post("/logout")
def logout(request: Request):
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        if token:
            acct = account_from_request(request)
            with _lock, _conn() as c:
                c.execute("DELETE FROM tokens WHERE token=?", (token,))
            audit.record(
                "logout",
                status="success",
                account_id=acct["id"] if acct else None,
                request=request,
            )
    return {"ok": True}


# --- Google Sign-In ----------------------------------------------------------

class GoogleBody(BaseModel):
    id_token: str = Field(..., min_length=10)
    platform: str = Field("", max_length=20)
    app_version: str = Field("", max_length=20)


def _verify_google_token(id_token_str: str) -> dict:
    """Verify a Google ID token and return its claims (sub, email, name, ...).

    Signature is always verified against Google's certs. The audience (client
    id) is only enforced when GOOGLE_CLIENT_ID is configured, so the scaffold
    works before you wire up your real OAuth client.
    """
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
    except Exception:
        raise HTTPException(status_code=500, detail="Google auth library unavailable")
    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_str,
            google_requests.Request(),
            GOOGLE_CLIENT_ID or None,
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Google sign-in. Please try again.")
    if not claims.get("sub"):
        raise HTTPException(status_code=401, detail="Google token missing account id")
    return claims


def _unique_username_c(c, base: str) -> str:
    """Pick a free username using an EXISTING connection (no locking).

    Callers already inside a `with _lock, _conn()` block must use this to avoid
    re-acquiring the non-reentrant lock (which would deadlock)."""
    base = _norm_username(re.sub(r"[^a-z0-9_]", "", base.lower())) or "gofit"
    base = base[:20]
    candidate = base
    n = 0
    while c.execute("SELECT 1 FROM accounts WHERE username=?", (candidate,)).fetchone():
        n += 1
        candidate = f"{base}{n}"
    return candidate


def _unique_username(base: str) -> str:
    with _lock, _conn() as c:
        return _unique_username_c(c, base)


@router.post("/google")
def google_login(body: GoogleBody, request: Request):
    claims = _verify_google_token(body.id_token)
    sub = claims["sub"]
    email = (claims.get("email") or "").strip().lower()
    name = (claims.get("name") or email.split("@")[0] or "gofit user").strip()
    avatar = claims.get("picture") or "🫵"

    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM accounts WHERE google_sub=?", (sub,)).fetchone()
        is_new = False
        if not row and email:
            # Link a pre-existing account that used the same email.
            row = c.execute("SELECT * FROM accounts WHERE email=?", (email,)).fetchone()
            if row:
                c.execute("UPDATE accounts SET google_sub=? WHERE id=?", (sub, row["id"]))
        if not row:
            is_new = True
            username = _unique_username_c(c, email.split("@")[0] if email else "gofit")
            cur = c.execute(
                """
                INSERT INTO accounts
                    (username, name, avatar, pw_hash, pw_salt, google_sub, email, created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (username, name, avatar, "", "", sub, email, time.time()),
            )
            account_id = cur.lastrowid
        else:
            account_id = row["id"]
        row = c.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()

    token = _issue_token(account_id, platform=body.platform, app_version=body.app_version)
    audit.record(
        "account_created" if is_new else "account_signin",
        status="success",
        account_id=account_id,
        detail=email or None,
        request=request,
    )
    if is_new and email:
        _push_pool.submit(email_service.send_welcome_email, email, name)
    return {"token": token, "account": _account_public(row)}


# --- Email one-time-code sign-in --------------------------------------------
# An alternative to Google Sign-In for anyone who'd rather not use Google (or
# is testing on a device where Google Sign-In isn't set up). Same outcome as
# /auth/google: mints/returns a bearer token for an account keyed by email.

_OTP_TTL_SECONDS = 10 * 60
_OTP_MAX_ATTEMPTS = 5
_OTP_RESEND_COOLDOWN = 45  # seconds before the same email can request another code


class OtpRequestBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)


class OtpVerifyBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=120)
    code: str = Field(..., min_length=4, max_length=8)
    platform: str = Field("", max_length=20)
    app_version: str = Field("", max_length=20)


def _norm_email(e: str) -> str:
    return e.strip().lower()


def _otp_send_error_detail(reason: Optional[str]) -> str:
    if reason == "missing_api_key":
        return "OTP email is unavailable: RESEND_API_KEY is missing on the server."
    if reason == "invalid_api_key":
        return "OTP email is unavailable: RESEND_API_KEY is invalid or rejected."
    if reason == "from_domain_not_verified":
        return "OTP email is unavailable: RESEND_FROM sender domain is not verified in Resend."
    if reason == "recipient_not_allowed_in_test_mode":
        return "OTP email is unavailable: Resend test mode allows only approved recipient addresses."
    return "OTP email is unavailable right now. Please contact support."


@router.post("/otp/request")
def otp_request(body: OtpRequestBody, request: Request):
    if not ENABLE_OTP_LOGIN:
        raise HTTPException(status_code=503, detail="Email code sign-in is temporarily disabled. Please use Google Sign-In.")
    email = _norm_email(body.email)
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    now = time.time()
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    with _lock, _conn() as c:
        existing = c.execute(
            "SELECT created_at FROM otp_codes WHERE email=?", (email,)
        ).fetchone()
        if existing and now - existing["created_at"] < _OTP_RESEND_COOLDOWN:
            wait = int(_OTP_RESEND_COOLDOWN - (now - existing["created_at"]))
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another code")
        c.execute(
            """
            INSERT INTO otp_codes (email, code_hash, attempts, created_at, expires_at)
            VALUES (?,?,0,?,?)
            ON CONFLICT(email) DO UPDATE SET
                code_hash=excluded.code_hash, attempts=0,
                created_at=excluded.created_at, expires_at=excluded.expires_at
            """,
            (email, code_hash, now, now + _OTP_TTL_SECONDS),
        )
    sent, reason = email_service.send_otp_email_result(email, code)
    status = "success" if sent else f"email_failed:{reason or 'unknown'}"
    audit.record("otp_request", status=status, detail=email, request=request)
    # In dev (no email provider configured yet) surface the code directly so
    # the flow is still testable end-to-end without Resend set up.
    if not sent and not ALLOW_DEV_LOGIN:
        raise HTTPException(
            status_code=503,
            detail=_otp_send_error_detail(reason),
        )
    return {"ok": True, "sent": sent}


@router.post("/otp/verify")
def otp_verify(body: OtpVerifyBody, request: Request):
    if not ENABLE_OTP_LOGIN:
        raise HTTPException(status_code=503, detail="Email code sign-in is temporarily disabled. Please use Google Sign-In.")
    email = _norm_email(body.email)
    code = body.code.strip()
    now = time.time()
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM otp_codes WHERE email=?", (email,)).fetchone()
        if not row or row["expires_at"] < now:
            raise HTTPException(status_code=400, detail="Code expired. Request a new one.")
        if row["attempts"] >= _OTP_MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Too many attempts. Request a new code.")
        if hashlib.sha256(code.encode()).hexdigest() != row["code_hash"]:
            c.execute("UPDATE otp_codes SET attempts=attempts+1 WHERE email=?", (email,))
            raise HTTPException(status_code=400, detail="Incorrect code")
        c.execute("DELETE FROM otp_codes WHERE email=?", (email,))

        acct_row = c.execute("SELECT * FROM accounts WHERE email=?", (email,)).fetchone()
        is_new = False
        if not acct_row:
            is_new = True
            username = _unique_username_c(c, email.split("@")[0])
            cur = c.execute(
                """
                INSERT INTO accounts
                    (username, name, avatar, pw_hash, pw_salt, google_sub, email, created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (username, email.split("@")[0], "🫵", "", "", f"otp-{email}", email, now),
            )
            account_id = cur.lastrowid
        else:
            account_id = acct_row["id"]
        acct_row = c.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()

    token = _issue_token(account_id, platform=body.platform, app_version=body.app_version)
    audit.record(
        "account_created" if is_new else "account_signin",
        status="success",
        account_id=account_id,
        detail=f"otp:{email}",
        request=request,
    )
    if is_new:
        _push_pool.submit(email_service.send_welcome_email, email, acct_row["name"])
    return {"token": token, "account": _account_public(acct_row)}


DEV_SUB = "dev-tester"


@router.post("/dev")
def dev_login(request: Request):
    """TEST-ONLY login: return a token for a shared Tester account, no Google.

    Enabled only when ALLOW_DEV_LOGIN is set. The tester is marked Pro so the
    paywall never blocks testing. Returns the same shape as /auth/google."""
    if not ALLOW_DEV_LOGIN:
        raise HTTPException(status_code=404, detail="Not found")
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM accounts WHERE google_sub=?", (DEV_SUB,)).fetchone()
        if not row:
            username = _unique_username_c(c, "tester")
            cur = c.execute(
                """
                INSERT INTO accounts
                    (username, name, avatar, pw_hash, pw_salt, google_sub, email, is_pro, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (username, "Tester", "🍛", "", "", DEV_SUB, "tester@gofit.local", 1, time.time()),
            )
            account_id = cur.lastrowid
        else:
            account_id = row["id"]
        row = c.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    token = _issue_token(account_id)
    audit.record(
        "dev_login",
        status="success",
        account_id=account_id,
        detail="POST /auth/dev (ALLOW_DEV_LOGIN)",
        request=request,
    )
    return {"token": token, "account": _account_public(row)}


@router.post("/upgrade")
def upgrade(request: Request):
    """TEST-ONLY instant Pro (no payment). Real upgrades go through Razorpay
    (POST /pay/order + /pay/verify). Disabled unless ALLOW_DEV_LOGIN is set so it
    can't be used to bypass payment in production."""
    if not ALLOW_DEV_LOGIN:
        raise HTTPException(status_code=404, detail="Not found")
    acct = require_account(request)
    updated = set_pro(acct["id"], True)
    # Flagged distinctly from real Razorpay grants (payments.py's
    # "pro_granted" event) -- this path bypasses payment entirely and must
    # never be reachable when ALLOW_DEV_LOGIN is off (enforced above).
    audit.record(
        "pro_granted_dev_bypass",
        status="no_payment",
        account_id=acct["id"],
        detail="POST /auth/upgrade (ALLOW_DEV_LOGIN)",
        request=request,
    )
    return {"account": updated}


class PushTokenBody(BaseModel):
    token: str = Field(..., min_length=1, max_length=256)
    platform: str = Field("", max_length=16)


@router.post("/push-token")
def push_token(body: PushTokenBody, request: Request):
    """Register this device's Expo push token against the signed-in account."""
    acct = require_account(request)
    register_push_token(acct["id"], body.token, body.platform)
    return {"ok": True}


@router.get("/devices")
def list_devices(request: Request):
    """This account's sessions -- which platforms, which app versions, when
    each was last active. Never exposes the real bearer tokens."""
    acct = require_account(request)
    return {"devices": devices_for_account(acct["id"])}


class NotificationPrefsBody(BaseModel):
    push_likes: bool = True
    push_comments: bool = True
    push_community: bool = True


@router.get("/notification-prefs")
def notification_prefs(request: Request):
    acct = require_account(request)
    return {"prefs": get_notification_prefs(acct["id"])}


@router.put("/notification-prefs")
def update_notification_prefs(body: NotificationPrefsBody, request: Request):
    acct = require_account(request)
    prefs = set_notification_prefs(
        acct["id"], body.push_likes, body.push_comments, body.push_community
    )
    return {"prefs": prefs}
