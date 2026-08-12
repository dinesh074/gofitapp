#!/usr/bin/env bash
# gofit.today backend launcher (macOS / Linux).
# Loads secrets from .env automatically (via python-dotenv inside the app).
#
#   ./run.sh              # start on :8000
#   ./run.sh --reload     # hot-reload during development
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "WARNING: No .env found. Copy .env.example to .env and fill it in. Falling back to SQLite." >&2
fi

export PYTHONIOENCODING=utf-8
exec python -m uvicorn main:app --host 0.0.0.0 --port 8000 "$@"
