# DCR La Ceiba Stream Monitor

Lightweight, serverless uptime monitor for DCR Radio's live audio stream.
Built to power push notifications in the DCR Radio mobile app.

## How It Works

A GitHub Actions workflow runs `monitor.js` on a scheduled interval (every 5 minutes).
The script pings the stream endpoint and compares the HTTP response against the
previously saved state:

- **200 OK** → stream is live
- **Non-200** → stream is down

If the status *changed* since the last run, the monitor updates `stream-status.json`
and triggers a push notification to app users. If nothing changed, it exits silently.

## Architecture
GitHub Actions (cron: every 5 min)
│
▼
monitor.js
├── Fetch stream endpoint
├── Compare with state.json (previous status)
├── If changed → update stream-status.json + trigger notification
└── Save new state → state.json

**No server required.** The entire monitoring pipeline runs on GitHub Actions,
and `stream-status.json` serves as a lightweight API endpoint consumed by the app.

## Stack

- **Runtime:** Node.js
- **Scheduler:** GitHub Actions (scheduled workflow)
- **State persistence:** `state.json` (committed on each status change)
- **Output:** `stream-status.json` (read by the DCR Radio app)

## Files

| File | Purpose |
|------|---------|
| `monitor.js` | Core monitoring logic |
| `state.json` | Persisted stream state between runs |
| `stream-status.json` | Current stream status consumed by the app |
| `.github/workflows/` | Scheduled GitHub Actions pipeline |

## Related

- [DCR Radio Support Portal](https://github.com/Kevgz-netplus/dcr-radio-support)
- [DCR Radio Assets](https://github.com/Kevgz-netplus/dcr-radio-assets)
