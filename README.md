# DCR La Ceiba Stream Monitor

Lightweight, serverless uptime monitor for DCR Radio's live audio stream.
Built to power push notifications in the DCR Radio mobile app.

## How It Works

A GitHub Actions workflow runs `monitor.js` on a scheduled interval. The script
probes the stream endpoint and compares the result against the previously saved
state:

- **200 OK** → the probe passed
- **Non-200, timeout or network error** → the probe failed

**The stream is only declared down once two of three probes fail**, five seconds
apart. One failed request is not evidence: the probe runs on a shared GitHub
runner over the public internet, so an isolated failure usually says more about
the runner than about the transmitter in La Ceiba. Probing stops as soon as the
probes left cannot change the verdict, so a healthy stream costs two requests.

If the status changed since the last run, the monitor updates
`stream-status.json` and sends a push notification. If nothing changed, it
writes nothing and there is nothing to commit.

### Scheduling, honestly

The cron says every 5 minutes. It has never run that often: measured across
2,020 runs, the median gap was **63 minutes** and the worst was **11.6 hours**.
Scheduled workflows on GitHub's free tier are queued and dropped under load.
Treat the interval as best effort, not as a guarantee.

## Architecture
GitHub Actions (cron: every 5 min)
│
▼
monitor.js
├── Fetch stream endpoint
├── Compare with state.json (previous status)
├── If changed → update stream-status.json + trigger notification
└── Save new state → state.json

**No server required.** The entire monitoring pipeline runs on GitHub Actions.

`stream-status.json` is a human-readable record of the last change, not an app
endpoint: the DCR Radio app learns about outages through the FCM topic and never
reads this file.

## Stack

- **Runtime:** Node.js
- **Scheduler:** GitHub Actions (scheduled workflow)
- **State persistence:** `state.json` (committed when the status changes)
- **Output:** `stream-status.json` (human-readable; see above)

`state.json` keeps two fields apart on purpose: `lastStatus` is what was last
seen, `lastNotifiedStatus` is what listeners were last told. They differ only
when a notification failed to go out, which is what makes it safe to record an
observation straight away and still retry the push on the next run.

## Files

| File | Purpose |
|------|---------|
| `monitor.js` | Core monitoring logic |
| `state.json` | Last status seen, and last status announced |
| `stream-status.json` | Last status change, in readable form |
| `.github/workflows/` | Scheduled GitHub Actions pipeline |

## Related

- [DCR Radio Support Portal](https://github.com/Kevgz-netplus/dcr-radio-support)
- [DCR Radio Assets](https://github.com/Kevgz-netplus/dcr-radio-assets)
