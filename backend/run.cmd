@echo off
REM gofit.today backend launcher (Windows, no PowerShell execution-policy needed).
REM Loads secrets from .env automatically (via python-dotenv inside the app).
REM
REM   run.cmd              start on :8000
REM   run.cmd --reload     hot-reload during development
REM   run.cmd --port 9000  extra args pass straight to uvicorn
setlocal
cd /d "%~dp0"
if not exist ".env" echo WARNING: No .env found. Copy .env.example to .env. Falling back to SQLite.
set PYTHONIOENCODING=utf-8
python -m uvicorn main:app --host 0.0.0.0 --port 8000 %*
