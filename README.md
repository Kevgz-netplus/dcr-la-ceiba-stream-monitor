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
