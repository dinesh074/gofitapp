"""
gofit.today — database access layer.

Speaks two backends behind one tiny sqlite3-compatible API so the rest of the
code (auth.py, community.py) is written once:

  * SQLite  — the default. A local file `community.db` next to the code. Zero
              setup, perfect for local dev.
  * Postgres — used automatically when DATABASE_URL is set (e.g. a managed
              Supabase/Neon instance). Production-ready, persists anywhere,
              handles concurrency.

Switch backends purely by environment:

    # local dev (default) -> SQLite file
    (no env)

    # production -> managed Postgres
    $env:DATABASE_URL = "postgresql://user:pass@host:5432/dbname?sslmode=require"

The callers keep using the familiar sqlite3 idioms:

    with db.connect() as c:
        row = c.execute("SELECT * FROM accounts WHERE id=?", (i,)).fetchone()
        cur = c.execute("INSERT INTO posts (...) VALUES (?, ?)", (...))
        new_id = cur.lastrowid

`connect()` returns a real sqlite3 connection in SQLite mode (so behaviour is
byte-for-byte identical to before), or a thin Postgres shim that translates the
SQLite dialect to Postgres on the fly.
"""
import os
import re
import sqlite3
import atexit
import logging
import threading
import contextlib

log = logging.getLogger("gofit.db")

# Best-effort: load backend/.env so `import db` works even outside the app entry
# point (e.g. maintenance scripts). Idempotent if main.py already loaded it.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except Exception:
    pass

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = DATABASE_URL.lower().startswith(("postgres://", "postgresql://"))

SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "community.db")

# All Postgres objects live in a dedicated schema so we never collide with
# anything already present in the database's `public` schema (Supabase and
# earlier experiments may have left conflicting tables there).
PG_SCHEMA = os.environ.get("PG_SCHEMA", "gofit").strip() or "gofit"

# --- write serialization -----------------------------------------------------
# SQLite is single-writer: concurrent writers raise "database is locked", so we
# serialize access through one process-wide reentrant lock. Postgres handles
# concurrency itself (each thread gets its own pooled connection), so locking
# there would throttle the whole app to one query at a time — a no-op context
# manager is used instead. Callers do:  `with db.write_lock(), db.connect() as c:`
_write_lock = threading.RLock()
_nolock = contextlib.nullcontext()


def write_lock():
    """Return the shared write lock (SQLite) or a no-op (Postgres)."""
    return _nolock if IS_POSTGRES else _write_lock

# Tables whose primary key is a serial `id` column. Only for these do we append
# `RETURNING id` to plain INSERTs so `cursor.lastrowid` keeps working on
# Postgres. (Text-PK tables like `tokens`, `groups`, `users` are excluded.)
_ID_TABLES = {"accounts", "posts", "post_comments", "notifications"}
_INSERT_TABLE_RE = re.compile(r"insert\s+into\s+([a-z_][a-z0-9_]*)", re.I)
_AUTOINC_RE = re.compile(r"integer\s+primary\s+key\s+autoincrement", re.I)
_REAL_RE = re.compile(r"\bREAL\b", re.I)
_OR_IGNORE_RE = re.compile(r"insert\s+or\s+ignore\s+into", re.I)


# --------------------------------------------------------------------------- #
#  Postgres path
# --------------------------------------------------------------------------- #
_pool = None


def _init_pg_pool():
    global _pool
    if _pool is not None:
        return _pool
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool
    import psycopg

    # libpq accepts both schemes, but normalise to be safe.
    url = "postgresql://" + DATABASE_URL.split("://", 1)[1]

    # Create the schema ONCE up front (a single connection) so pooled
    # connections don't race on `CREATE SCHEMA IF NOT EXISTS` (which has a
    # known time-of-check/time-of-use race under concurrency).
    with psycopg.connect(url, autocommit=True) as _c:
        _c.execute(f'CREATE SCHEMA IF NOT EXISTS "{PG_SCHEMA}"')

    def _configure(conn):
        # Put our schema first on the search_path so unqualified table names
        # resolve to our objects. Must leave the connection idle (committed),
        # or the pool rejects it.
        conn.execute(f'SET search_path TO "{PG_SCHEMA}", public')
        conn.commit()

    _pool = ConnectionPool(
        conninfo=url,
        min_size=int(os.environ.get("PG_POOL_MIN", "2")),
        max_size=int(os.environ.get("PG_POOL_MAX", "20")),
        timeout=float(os.environ.get("PG_POOL_TIMEOUT", "10")),
        max_idle=float(os.environ.get("PG_POOL_MAX_IDLE", "120")),
        open=True,
        configure=_configure,
        # Supabase's pooler (pgbouncer in front of Postgres) can close a
        # connection server-side while it's sitting idle in OUR pool -- our
        # side has no way to know until it tries to use it. check_connection
        # pings each connection on checkout and transparently discards +
        # replaces it if the ping fails, so a request never gets handed a
        # connection that's already dead. Without this, a live request would
        # get psycopg.OperationalError: "the connection is lost" (a real bug
        # hit in production: it surfaced as a 500 on /community/sync and
        # /auth/google, which the app has no retry for -- e.g. a stuck
        # sign-in spinner with no visible error).
        check=ConnectionPool.check_connection,
        # dict rows => row["col"] access, matching sqlite3.Row.
        # prepare_threshold=None keeps us compatible with transaction-mode
        # poolers (e.g. Supabase pgbouncer) that dislike prepared statements.
        kwargs={"row_factory": dict_row, "prepare_threshold": None},
    )
    return _pool


def _translate(sql: str):
    """Rewrite a SQLite statement to Postgres. Returns (sql, appended_returning)."""
    s = sql
    ignore = bool(_OR_IGNORE_RE.search(s))
    if ignore:
        s = _OR_IGNORE_RE.sub("INSERT INTO", s)
    # psycopg uses %-style params, so any literal '%' in the SQL (e.g. a LIKE
    # pattern) must be doubled BEFORE we introduce our own %s placeholders.
    s = s.replace("%", "%%")
    # placeholders
    s = s.replace("?", "%s")
    # DDL dialect
    s = _AUTOINC_RE.sub("BIGSERIAL PRIMARY KEY", s)
    s = _REAL_RE.sub("DOUBLE PRECISION", s)

    low = s.lower()
    has_conflict = "on conflict" in low
    has_returning = "returning" in low
    is_insert = low.lstrip().startswith("insert")

    if ignore and not has_conflict:
        s = s.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
        has_conflict = True

    appended_returning = False
    if is_insert and not has_conflict and not has_returning:
        m = _INSERT_TABLE_RE.search(s)
        if m and m.group(1).lower() in _ID_TABLES:
            s = s.rstrip().rstrip(";") + " RETURNING id"
            appended_returning = True
    return s, appended_returning


class _PgCur:
    """A cursor wrapper exposing the sqlite3 cursor surface we rely on."""

    def __init__(self, cur, lastrowid=None):
        self._cur = cur
        self.lastrowid = lastrowid
        self.rowcount = cur.rowcount

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()


class _PgConn:
    """Context-managed connection mimicking sqlite3.Connection semantics."""

    def __init__(self, raw):
        self._raw = raw

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        broken = False
        try:
            if exc_type:
                self._raw.rollback()
            else:
                self._raw.commit()
        except Exception:
            # The connection died mid-request (server closed it, network
            # blip, etc). rollback()/commit() on a dead connection raises
            # too -- letting that propagate would REPLACE the original
            # exception with this one, hiding what actually went wrong.
            # Swallow it: the caller already has (or is about to get) the
            # real error from whatever execute() call failed first.
            broken = True
            log.warning("db: connection died on exit, discarding from pool", exc_info=True)
        finally:
            if broken:
                # Don't hand a known-dead connection back to the pool as if
                # it were healthy -- close it first so the pool opens a
                # fresh replacement instead of recycling it.
                try:
                    self._raw.close()
                except Exception:
                    pass
            _pool.putconn(self._raw)
        return False

    def execute(self, sql, params=()):
        tsql, ret_id = _translate(sql)
        cur = self._raw.cursor()
        cur.execute(tsql, tuple(params))
        lastrowid = None
        if ret_id:
            row = cur.fetchone()
            lastrowid = row["id"] if row else None
        return _PgCur(cur, lastrowid)

    def executemany(self, sql, seq_of_params):
        tsql, _ = _translate(sql)
        cur = self._raw.cursor()
        cur.executemany(tsql, [tuple(p) for p in seq_of_params])
        return _PgCur(cur)

    def executescript(self, script):
        cur = self._raw.cursor()
        for stmt in script.split(";"):
            if stmt.strip():
                tsql, _ = _translate(stmt)
                cur.execute(tsql)
        return _PgCur(cur)


# --------------------------------------------------------------------------- #
#  Public API
# --------------------------------------------------------------------------- #
def connect():
    """Return a context-managed DB connection for the active backend."""
    if IS_POSTGRES:
        pool = _init_pg_pool()
        return _PgConn(pool.getconn())
    c = sqlite3.connect(SQLITE_PATH)
    c.row_factory = sqlite3.Row
    return c


def table_columns(conn, table: str) -> set:
    """Return the set of column names for a table (both backends)."""
    if IS_POSTGRES:
        rows = conn.execute(
            "SELECT column_name AS name FROM information_schema.columns "
            "WHERE table_name=? AND table_schema=?",
            (table, PG_SCHEMA),
        ).fetchall()
        return {r["name"] for r in rows}
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r["name"] for r in rows}


def backend_name() -> str:
    return "postgres" if IS_POSTGRES else "sqlite"


def ping() -> bool:
    """Cheap connectivity check used by readiness probes. Returns True if a
    round-trip `SELECT 1` succeeds, else raises the underlying error."""
    with connect() as conn:
        row = conn.execute("SELECT 1 AS ok").fetchone()
        return bool(row and (row["ok"] == 1))


@atexit.register
def _close_pool():
    """Close the connection pool cleanly on interpreter exit."""
    global _pool
    if _pool is not None:
        try:
            _pool.close()
        except Exception:
            pass
        _pool = None
