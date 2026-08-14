"""
gofit.today -- Supabase Storage integration for post images.

Replaces saving to a local `uploads/` folder (not durable on most hosting
platforms -- see DEPLOY.md) with real object storage, using buckets that
already exist in the Supabase project: `community-photos` (public).

Config (env / .env):
  SUPABASE_URL               e.g. https://xxxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY  service_role key (Dashboard -> Settings -> API).
                             Server-only, bypasses Storage RLS -- never ship
                             this to the app; only the backend uses it.

Uses Supabase's plain Storage REST API via urllib (same style as the rest of
this codebase's HTTP calls, e.g. auth.py's Expo push) rather than pulling in
the full supabase-py SDK for one feature.
"""
import os
import json
import urllib.request
import urllib.error
from typing import Optional

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

COMMUNITY_BUCKET = "community-photos"
# Meal-scan photos are private diary data (not shared publicly like community
# posts), so this bucket is private -- reads go through short-lived signed
# URLs (see signed_url()) instead of a public URL.
MEAL_BUCKET = "meal-photos"


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def upload_meal_photo(path: str, data: bytes, content_type: str = "image/jpeg") -> str:
    """Upload a scanned-meal photo to the private meal-photos bucket.

    `path` should be `{account_id}/{image_hash}.jpg` -- hash-based so the same
    photo re-scanned by the same user overwrites (upsert) instead of
    duplicating storage. Returns the storage object path (not a public URL --
    use signed_url() to hand the client something it can actually load).
    Raises RuntimeError on failure; callers should treat this as best-effort
    and not fail the whole scan over a storage hiccup.
    """
    if not configured():
        raise RuntimeError("Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset)")
    url = f"{SUPABASE_URL}/storage/v1/object/{MEAL_BUCKET}/{path}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": content_type,
            "x-upsert": "true",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"Supabase Storage upload failed: {e.code} {detail}") from e
    except Exception as ex:
        raise RuntimeError(f"Supabase Storage upload failed: {ex}") from ex
    return path


def signed_url(path: str, expires_in: int = 21600, bucket: str = MEAL_BUCKET) -> Optional[str]:
    """Returns a short-lived (default 6h) signed URL for a private object, or
    None on any failure -- callers should degrade to "no photo" rather than
    error the whole request over a storage hiccup."""
    if not configured():
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/sign/{bucket}/{path}"
    body = json.dumps({"expiresIn": expires_in}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        signed = data.get("signedURL") or data.get("signedUrl")
        if not signed:
            return None
        return f"{SUPABASE_URL}/storage/v1{signed}"
    except Exception:
        return None


def delete_meal_photo(path: str, bucket: str = MEAL_BUCKET) -> bool:
    """Best-effort delete, used by the retention job to drop photos older
    than the 7-day image-retention window. Returns False on any failure."""
    if not configured():
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}"
    body = json.dumps({"prefixes": [path]}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="DELETE",
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        return True
    except Exception:
        return False


def upload_community_photo(name: str, data: bytes, content_type: str = "image/jpeg") -> str:
    """Upload to the (public) community-photos bucket. Returns the public URL.

    Raises RuntimeError on failure -- callers should catch and fall back to
    local disk (see community.py) rather than 500 the whole request over a
    storage hiccup.
    """
    if not configured():
        raise RuntimeError("Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset)")
    url = f"{SUPABASE_URL}/storage/v1/object/{COMMUNITY_BUCKET}/{name}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": content_type,
            "x-upsert": "false",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"Supabase Storage upload failed: {e.code} {detail}") from e
    except Exception as ex:
        raise RuntimeError(f"Supabase Storage upload failed: {ex}") from ex
    return f"{SUPABASE_URL}/storage/v1/object/public/{COMMUNITY_BUCKET}/{name}"
