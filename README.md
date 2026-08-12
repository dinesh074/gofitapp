# gofit.today — MVP

Snap a photo of Indian food → AI itemizes it → you fix the portion in one tap →
accurate calories + macros + a running daily total against your personal goal.

## Why this design
Validation (see `../indian_food_test/`) proved that AI recognizes Indian dishes
well; the only real error is **piece-counting**. So the app never shows a final
number — it shows **editable cards with ± steppers**. Example: gulab jamun raw
error 2043% → 14% after a single count tap.

## Structure
```
calai-india/
  backend/   FastAPI. Holds the Gemini key server-side. POST /analyze.
  app/       Expo React Native (TypeScript). iOS + Android, one codebase.
```

## Run the backend
Secrets live in `backend/.env` (git-ignored). Copy the template, fill it in,
then use the launcher — it loads `.env` automatically, so you never re-type
`DATABASE_URL` / `GEMINI_API_KEY`.
```powershell
cd backend
pip install -r requirements.txt
Copy-Item .env.example .env    # then edit .env with your values
.\run.cmd                      # starts uvicorn on :8000
.\run.cmd --reload             # hot-reload during development
```
(macOS/Linux: `./run.sh`. Prefer `run.ps1`? Run it once as
`powershell -ExecutionPolicy Bypass -File run.ps1` if script execution is
disabled.) Test: `curl http://127.0.0.1:8000/health` — or
`curl -F "file=@../../indian_food_test/images/idli.jpg" http://127.0.0.1:8000/analyze`

### Database
The backend uses **Postgres** when `DATABASE_URL` is set (e.g. a managed
Supabase/Neon instance), otherwise a local **SQLite** file (`community.db`) —
zero setup for dev. The same code runs on both. All Postgres objects live in a
dedicated `gofit` schema so they never collide with other tables in the
database. `GET /health` reports the active backend (`"db":"postgres"` or
`"sqlite"`).
```dotenv
# backend/.env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require"
```
URL-encode special characters in the password (e.g. `@` → `%40`, `#` → `%23`).

### Security
- **Auth:** set `APP_API_KEY` and the app must send a matching `X-API-Key` header
  (set `API_KEY` in `app/config.ts`). Unset = open (dev only).
- **Rate limiting:** per-client (API key or IP) per-minute + per-day caps protect
  your Gemini quota/budget. Returns HTTP 429 when exceeded.
- Uploads capped at 8 MB and validated as images. CORS via `ALLOWED_ORIGINS`.

## Run the app
```powershell
cd app
npm install
npx expo start
```
Scan the QR code with the **Expo Go** app on your phone.

IMPORTANT: on a physical phone, set `app/config.ts` `API_BASE` to your computer's
LAN IP (e.g. `http://192.168.1.20:8000`) — `127.0.0.1` only works on
web/simulator.

## Core files
- `app/App.tsx`        — home dashboard: goal progress + scan → editable cards.
- `app/Onboarding.tsx` — first-run wizard (body metrics → personal calorie goal).
- `app/Settings.tsx`   — edit profile, live goal recompute, reset all data.
- `app/nutrition.ts`   — Mifflin-St Jeor BMR/TDEE/goal + macro split.
- `app/api.ts`         — uploads image to `/analyze` (+ API key, friendly errors).
- `app/config.ts`      — backend URL, API key, branding.
- `backend/main.py`    — Gemini call, IFCT anchoring, auth, rate limiting.

## Next
Expand IFCT food DB coverage, subscription (RevenueCat), diabetes/sugar mode,
per-user accounts.
