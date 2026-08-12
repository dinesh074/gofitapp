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
import urllib.request
import urllib.error

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

COMMUNITY_BUCKET = "community-photos"


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


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
