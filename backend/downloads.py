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
    advertised."""
    if not audit.ADMIN_KEY:
        raise HTTPException(status_code=404, detail="Not found")
    if request.headers.get("x-admin-key", "").strip() != audit.ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    with db.write_lock(), db.connect() as c:
        c.execute(
            """
            INSERT INTO app_downloads (name, content, content_type, bytes, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                content=excluded.content, content_type=excluded.content_type,
                bytes=excluded.bytes, updated_at=excluded.updated_at
            """,
            ("gofit-today.apk", data, "application/vnd.android.package-archive", len(data), time.time()),
        )
    return {"bytes": len(data), "url": "/download/apk"}


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
