# Deploying the gofit.today backend

The backend is a stateless FastAPI app (`backend/main.py`) that talks to managed
Postgres (Supabase) and the Gemini API. It can run on any container/VM host
(Render, Railway, Fly.io, Azure App Service, a plain VM, etc.).

## 1. Environment

Copy `.env.example` → `.env` and fill real values, or set these as the host's
environment variables (preferred in production — don't ship the `.env` file):

| Variable           | Required | Notes                                                        |
| ------------------ | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`     | prod     | Postgres URL. URL-encode password specials (`@`→`%40`). Blank = SQLite (dev only). |
| `PG_SCHEMA`        | no       | Table schema, defaults to `gofit`.                           |
| `GEMINI_API_KEY`   | yes      | Server-side only; never shipped in the app.                  |
| `GOOGLE_CLIENT_ID` | yes      | Public web OAuth client ID (used to verify Google ID tokens).|
| `APP_ENV`          | prod     | Set to `production` to enable startup security/config warnings. |
| `ALLOWED_ORIGINS`  | prod     | Comma-separated CORS allow-list, e.g. `https://app.gofit.today`. |
| `APP_API_KEY`      | rec.     | If set, `/analyze` requires a matching `X-API-Key` header.   |
| `ALLOW_DEV_LOGIN`  | **off**  | Enables `POST /auth/dev` test login. MUST be unset in prod.  |
| `RAZORPAY_KEY_ID`  | prod     | Public Razorpay key id (`rzp_live_…`).                       |
| `RAZORPAY_KEY_SECRET` | prod  | Razorpay key secret — server only, never shipped.           |
| `RAZORPAY_WEBHOOK_SECRET` | rec. | Secret set on the Razorpay webhook; enables the backstop.  |
| `PRO_PRICE_PAISE`  | no       | Pro price in paise (default `29900` = ₹299).                 |
| `FREE_SCANS`       | no       | Free scans per account before paywall (default 3).           |
| `RATE_PER_MIN` / `RATE_PER_DAY` | no | Per-client rate limits (defaults 20 / 200).            |
| `ADMIN_KEY`        | rec.     | Gates `GET /admin/audit` (the payment/auth audit trail). Unset = endpoint 404s; the table is still written either way. |

## 2. Install & run

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

For production use multiple workers behind the platform's process manager, e.g.:

```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2 --proxy-headers
```

- `--proxy-headers` makes `X-Forwarded-For` trusted so per-IP rate limiting keys
  on the real client IP behind the load balancer.
- Rate limiting is **in-memory per process**. With multiple workers/instances the
  effective limit multiplies; for strict global limits move the limiter to Redis.

## 3. Health & readiness probes

| Endpoint  | Purpose    | Success | Failure |
| --------- | ---------- | ------- | ------- |
| `GET /health` | Liveness — process is up (no external calls). | `200` | — |
| `GET /ready`  | Readiness — DB round-trip (`SELECT 1`). | `200 {"ready":true}` | `503` when DB down |

Point the platform's **liveness** probe at `/health` and its **readiness/traffic**
probe at `/ready` so a database outage takes the instance out of rotation instead
of serving errors.

## 4. Production checklist

- [ ] `APP_ENV=production` (turns on startup config/security warnings).
- [ ] `DATABASE_URL` points at Postgres (not SQLite).
- [ ] `ALLOWED_ORIGINS` set to explicit domain(s) — **not** `*`.
- [ ] `ALLOW_DEV_LOGIN` unset; client `AUTH_BYPASS=false` in `app/config.ts`.
- [ ] `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` set (live keys); webhook added
      with `RAZORPAY_WEBHOOK_SECRET`.
- [ ] `APP_API_KEY` set and shipped to the app as `X-API-Key` (if using the gate).
- [ ] Rotate any secrets shared during development (DB password, Gemini key,
      OAuth client secret).
- [ ] Serve over HTTPS (terminate TLS at the platform/load balancer).
- [ ] Google Cloud Console: add the production web origin to the OAuth client's
      **Authorized JavaScript origins** (fixes the 401/403 origin errors).
- [ ] `ADMIN_KEY` set to a long random value (`openssl rand -hex 32`) so the
      payment audit trail (`GET /admin/audit`) is actually checkable in prod.

## 5. Payments (Razorpay)

Pro upgrades run through Razorpay; the key secret stays server-side.

1. Create keys in the Razorpay Dashboard → Settings → API Keys. Set
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (use `rzp_test_…` while testing).
2. Add a webhook (Dashboard → Webhooks) pointing at `https://<host>/pay/webhook`,
   subscribe to `payment.captured` and `order.paid`, and set its secret as
   `RAZORPAY_WEBHOOK_SECRET`. This is the durable backstop that grants Pro even
   if the app closes before the client-side verify runs.
3. Flow: `POST /pay/order` (auth) creates an order → the app opens Razorpay
   Checkout (web: `checkout.js`; native: the hosted `/pay/checkout` page in an
   in-app browser) → `POST /pay/verify` validates the signature and flips the
   account to Pro. The client never sees the secret and can't self-grant Pro.
4. `GET /pay/config` reports whether payments are configured; the app's paywall
   uses it (and, in test mode only, falls back to an instant unlock).

Price is fixed server-side (`PRO_PRICE_PAISE`), so a tampered client can't change
what it's charged.

## 6. Audit log

`audit.py` keeps a permanent, append-only record (`audit_log` table) of every
payment order/verify/webhook event — including failed/forged signature
attempts, not just successes — plus account sign-ins and any test-mode Pro
grant. Nothing ever updates or deletes a row; the only write path is `INSERT`.

Query it directly with SQL, or over HTTP once `ADMIN_KEY` is set:

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" "https://<host>/admin/audit?limit=50"
curl -H "X-Admin-Key: $ADMIN_KEY" "https://<host>/admin/audit?event=payment_verify_failed"
curl -H "X-Admin-Key: $ADMIN_KEY" "https://<host>/admin/audit?account_id=7"
```

Events recorded: `order_created`, `order_create_failed`, `payment_verify_failed`
(bad signature or unknown order — worth watching for repeated hits from one IP),
`webhook_received`, `webhook_rejected`, `pro_granted` (tagged `source=verify` or
`source=webhook` in `detail`), `pro_granted_dev_bypass` (should never appear in
prod — means `ALLOW_DEV_LOGIN` was on), `account_created`, `account_signin`,
`dev_login`, `logout`. This is our own record of what the server did, not a
replacement for Razorpay's dashboard, which stays the source of truth for the
money itself.

## 7. Scaling (high throughput, e.g. 40k req/min ≈ 670 req/s)

The app is stateless (all state in Postgres), so it scales horizontally. To hit
high request rates:

1. **Co-locate the app with the database.** The single biggest latency factor is
   DB round-trip time. Run the app in the **same region as Supabase**
   (`ap-southeast-1` here). Cross-region RTT of ~600ms per query caps a worker at
   a few req/s; co-located (~1–5ms) a single worker handles hundreds.
2. **Use the transaction pooler.** Point `DATABASE_URL` at Supabase's
   **transaction** pooler (host port **6543**), not session mode (5432). It
   multiplexes many clients onto few Postgres connections. Keep
   `prepare_threshold=None` (already set).
3. **Size the pool + threadpool together.** Sync endpoints run in Starlette's
   threadpool (default 40). Set `PG_POOL_MAX` ≥ the threadpool size per process
   (e.g. `PG_POOL_MAX=40`). Raise the threadpool if needed.
4. **Run multiple workers/instances** behind a load balancer:
   `uvicorn main:app --workers N --proxy-headers` (or several containers). Rule of
   thumb: `workers ≈ CPU cores`. Total DB connections = `workers × PG_POOL_MAX`,
   so keep that under the pooler's limit.
5. **Rate limiting is per-process/in-memory.** With N workers the effective limit
   multiplies and isn't shared. For a strict global limit, move the limiter to
   Redis. The current limiter is memory-bounded (idle clients are swept).
6. **`/analyze` is special.** Each call is a slow, paid Gemini request; it is
   rate-limited per client and capped at 8MB uploads. At very high volume, put it
   behind a queue/backpressure and watch Gemini quotas — don't size it like the
   cheap JSON endpoints.
7. **Trim access logging** at high RPS (`--no-access-log`) to cut log I/O.

Concurrency knobs (env): `PG_POOL_MIN`, `PG_POOL_MAX`, `PG_POOL_TIMEOUT`,
`PUSH_WORKERS`, `RATE_PER_MIN`, `RATE_PER_DAY`.

## 8. Notes

- On boot the app logs a one-line readiness summary and warns about any missing
  critical config or insecure dev toggles — check the logs after each deploy.
- The `gofit` Postgres schema is created automatically on first connect; no
  manual migration step is required.
- Uploaded post images live under `backend/uploads/`. On ephemeral/container
  filesystems this is not durable — mount a volume or move to object storage
  (e.g. S3/Supabase Storage) for production.
