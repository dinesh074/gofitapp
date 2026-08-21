"""
gofit.today — permanent binary-file hosting for small "app assets" that need
a stable, unauthenticated download URL (currently just the sideloadable
Android APK for the landing page's "Download for Android" button).

Why not Supabase Storage (like community photos)? Its free-tier per-object
cap is 50MB and the APK is ~100MB+ -- a real 413 "Payload too large" was hit
trying that route. Why not GitHub Releases? The source repo is private, so a
release-asset link 404s for anyone without repo access. Postgres itself has
no such per-object limit (BYTEA/BLOB rows well over 100MB are routine), and
we already have a live Postgres connection on Render, so storing the file
there and having THIS backend serve it directly is the simplest thing that
is both free and actually public.
"""
from __future__ import annotations

import time
import logging

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import Response

import db
import audit

log = logging.getLogger("gofit.downloads")
router = APIRouter(tags=["downloads"])

_BLOB_COL_TYPE = "BYTEA" if db.IS_POSTGRES else "BLOB"


def init_db() -> None:
    with db.connect() as c:
        c.execute(
            f"""
            CREATE TABLE IF NOT EXISTS app_downloads (
                name         TEXT PRIMARY KEY,
                content      {_BLOB_COL_TYPE} NOT NULL,
                content_type TEXT NOT NULL,
                bytes        INTEGER NOT NULL,
                updated_at   REAL NOT NULL
            )
            """
        )


@router.post("/admin/upload-apk")
async def admin_upload_apk(request: Request, file: UploadFile = File(...)):
    """One-off admin utility: upload a freshly-built EAS APK so it's served
    directly from this backend at a stable URL (/download/apk), forever --
    unlike EAS's own build-artifact links, which expire after ~2 weeks on the
    free plan. Gated by X-Admin-Key exactly like the other /admin/* endpoints
    -- 404s (not 401) when ADMIN_KEY is unset, so its existence isn't
    advertised.

    Only good for files that fit in a single request -- Render's free-tier
    proxy in front of this service was measured (directly, with dummy files)
    to hard-fail requests somewhere between 60MB and 90MB (fast 502, not a
    slow timeout), well under the real APK's ~103MB. For anything that big,
    use the chunked endpoints below instead."""
    if not audit.ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if request.headers.get("x-admin-key", "").strip() != audit.ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    _store("gofit-today.apk", data, "application/vnd.android.package-archive")
    return {"bytes": len(data), "url": "/download/apk"}


def _store(name: str, data: bytes, content_type: str) -> None:
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            INSERT INTO app_downloads (name, content, content_type, bytes, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                content=excluded.content, content_type=excluded.content_type,
                bytes=excluded.bytes, updated_at=excluded.updated_at
            """,
            (name, data, content_type, len(data), time.time()),
        )


def _require_admin(request: Request) -> None:
    if not audit.ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if request.headers.get("x-admin-key", "").strip() != audit.ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")


@router.post("/admin/upload-apk-chunk")
async def admin_upload_apk_chunk(
    request: Request, index: int, total: int, file: UploadFile = File(...)
):
    """Upload one piece of a large APK (each piece well under the ~60-90MB
    proxy ceiling above). Pieces are stashed as their own rows
    (`gofit-today.apk.part000`, `.part001`, ...) and only assembled into the
    real `gofit-today.apk` row by /admin/upload-apk-finalize once every piece
    has arrived -- so a half-finished upload never makes a broken file
    briefly downloadable."""
    _require_admin(request)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty chunk")
    _store(f"gofit-today.apk.part{index:04d}", data, "application/octet-stream")
    return {"index": index, "total": total, "bytes": len(data)}


@router.post("/admin/upload-apk-finalize")
def admin_upload_apk_finalize(request: Request, total: int):
    """Concatenate the `total` chunks uploaded via /admin/upload-apk-chunk
    (in order) into the real `gofit-today.apk` row, then delete the parts."""
    _require_admin(request)
    parts: list[bytes] = []
    with db.connect() as c:
        for i in range(total):
            row = c.execute(
                "SELECT content FROM app_downloads WHERE name = ?",
                (f"gofit-today.apk.part{i:04d}",),
            ).fetchone()
            if not row:
                raise HTTPException(status_code=400, detail=f"Missing chunk {i} of {total}")
            content = row["content"]
            parts.append(content if isinstance(content, (bytes, bytearray)) else bytes(content))
    full = b"".join(parts)
    _store("gofit-today.apk", full, "application/vnd.android.package-archive")
    with db.write_lock(), db.connect() as c:
        for i in range(total):
            c.execute("DELETE FROM app_downloads WHERE name = ?", (f"gofit-today.apk.part{i:04d}",))
    return {"bytes": len(full), "url": "/download/apk"}


@router.get("/download/apk")
def download_apk():
    """Public, unauthenticated -- this is the actual link the landing page's
    "Download for Android" button points to. Plain download, no scan credit
    or account involvement."""
    with db.connect() as c:
        row = c.execute(
            "SELECT content, content_type, bytes FROM app_downloads WHERE name = ?",
            ("gofit-today.apk",),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="APK not uploaded yet")
    content = row["content"]
    # psycopg hands back a Postgres memoryview for BYTEA; sqlite3 hands back
    # bytes directly -- normalize so Response() always gets plain bytes.
    if not isinstance(content, (bytes, bytearray)):
        content = bytes(content)
    return Response(
        content=content,
        media_type=row["content_type"],
        headers={
            "Content-Disposition": 'attachment; filename="gofit-today.apk"',
            "Content-Length": str(row["bytes"]),
        },
    )
