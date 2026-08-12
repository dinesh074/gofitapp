# gofit.today backend launcher (Windows / PowerShell).
# Loads secrets from .env automatically (via python-dotenv inside the app),
# so you never need to re-type DATABASE_URL / GEMINI_API_KEY each run.
#
#   .\run.ps1              # start on :8000
#   .\run.ps1 --reload     # hot-reload during development
#   .\run.ps1 --port 9000  # override args are passed straight to uvicorn

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path ".env")) {
    Write-Warning "No .env found. Copy .env.example to .env and fill it in. Falling back to SQLite."
}

# UTF-8 so emoji in seed data / logs don't crash the Windows console.
$env:PYTHONIOENCODING = "utf-8"

python -m uvicorn main:app --host 0.0.0.0 --port 8000 @args
