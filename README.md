# Maintenance service

Basic Express.js app configured for Google Cloud Run.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:8080

## Token health → Telegram

On a schedule (default every **15 minutes**, `America/Chicago`), the server calls **`https://api.cuub.tech/token/health`**. If the CUUB API is unreachable, the JSON is invalid, `success` is false, or **`tokenNeedsAttention`** is true, it messages **`TELEGRAM_CHAT_ID`** (same default group as the daily report) with the **`tokenRefreshUrl`** from the response (usually **`https://api.cuub.tech/token`**). While the problem persists, a repeat alert is sent at most every **6 hours** (`TOKEN_HEALTH_ALERT_REPEAT_HOURS`). When health is OK again after a failure, a short recovery message is sent.

| Variable | Default | Meaning |
|----------|---------|---------|
| `TOKEN_HEALTH_ALERTS` | `1` | Set to `0` / `false` / `off` to disable |
| `TOKEN_HEALTH_URL` | `https://api.cuub.tech/token/health` | Health endpoint |
| `TOKEN_REFRESH_URL` | `https://api.cuub.tech/token` | Fallback link in messages if the health JSON omits it |
| `TOKEN_HEALTH_CRON` | `*/15 * * * *` | Cron expression (Chicago TZ) |
| `TOKEN_HEALTH_ALERT_REPEAT_HOURS` | `6` | Hours between repeat failure alerts |

## Telegram `/status` polling

The bot loop used to **stop permanently** if `GET https://api.cuub.tech/stations` or Telegram `sendMessage` **never returned** (no timeout on `fetch`): after one hung `/status`, the next `getUpdates` was never scheduled. Timeouts and a `finally` reschedule are now in place. Optional env: `STATIONS_FETCH_TIMEOUT_MS`, `TELEGRAM_GET_UPDATES_TIMEOUT_MS`, `TELEGRAM_SEND_MESSAGE_TIMEOUT_MS`, `TELEGRAM_STATUS_COMMAND_TIMEOUT_MS`.

## Deploy to Cloud Run

```bash
gcloud run deploy maintenance-service --source . --region us-central1 --allow-unauthenticated
```

Or build and push the image yourself, then deploy the container to Cloud Run.

## Cloud Run deploy from GitHub (Developer Connect 403)

If the build fails with `developerconnect.gitRepositoryLinks.get` / `IAM_PERMISSION_DENIED`, Cloud Build’s service account cannot read your linked GitHub repo. From a machine with [gcloud](https://cloud.google.com/sdk/docs/install) and Owner (or IAM Admin) on the project:

```bash
gcloud config set project YOUR_PROJECT_ID
./scripts/grant-cloud-build-developer-connect.sh
```

Or manually:

```bash
PROJECT_ID=YOUR_PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/developerconnect.user"
```

To skip Git-linked builds entirely, deploy from your laptop (uploads source to Cloud Build; no Developer Connect fetch):

```bash
gcloud run deploy maintenance-service --source . --region us-central1 --allow-unauthenticated
```
