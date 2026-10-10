# status-worker

Cloudflare Worker behind `status.limooo.cn`: uptime probes, the public status page
and the alert channel that replaced Uptime Kuma.

- Cron `* * * * *` runs one round of probes and writes D1
  (`heartbeats`, `probe_state`, `probe_uptime_daily`).
- Cron `47 3 * * *` runs the D1 retention pass (`retention.ts`) and then the
  **daily checks** (`runDailyChecks()`), see below.
- A probe that crosses `FAIL_THRESHOLD` is handed to the `ProbeState` Durable
  Object, which re-checks it every `RETRY_INTERVAL_S` seconds and records recovery.
- Alerts go to `ALERT_WEBHOOK_URL` first (Feishu bot format by default) and fall
  back to the `EMAIL` binding; with neither configured they are only logged.

## Daily checks (`47 3 * * *`, once a day)

`47 3 * * *` sits after the archive cron (`0 0 * * *`) and the blocklist sync cron
(`30 3 * * *`), so both have already recorded their run for the day. Two invariants
are checked there, and each step fails open (log only, no alert, never throws):

| Step | Source | What it checks |
| --- | --- | --- |
| cron run failures | `runwatch.ts` | the latest `worker_runs` row for each job in `WATCHED_JOBS` (`blocklist_sync`, `d1_archive`, `config_backup`; migration 018) is `ok`/`skipped`; `failed`, an unknown outcome, or a `running` row older than `STALE_RUNNING_S` (2 h) alerts |
| blocklist drift | `blocklist.ts` | the Cloudflare IP List `limooo_blocklist` equals the `active = 1` rows of D1 `blocked_ips`; a non-empty `to_add`/`to_remove` alerts, agreement stays silent |

Cost per day: **4 rows read** (one index seek per watched job on
`idx_worker_runs_job_started`, one `SELECT cidr FROM blocked_ips WHERE active = 1`
on `idx_blocked_ips_active`) plus two read-only Cloudflare API calls (list lookup by
name, one items page). Adding a job to `WATCHED_JOBS` costs exactly one more row per
day; leaving it out costs the visibility this Worker exists to provide. Nothing here is read from the every-minute probe cron or
from the status page — the status page is served once per minute per language, so a
`worker_runs` read there would cost thousands of rows per day.

The checks are checked *and* alerted from the same place: an alert is one message
listing every finding, in `ALERT_LANG` (four languages in `ALERT_I18N`). Missing
Cloudflare credentials (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`) is a
skip, not a failure: a fresh clone without those secrets must not start alerting.

## Endpoints

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/` , `/status` | GET | public | Server-rendered status page (edge-cached, `Vary: Accept-Language`) |
| `/_health` | GET | public | Liveness probe used by external monitors |
| `/status.css`, `/status.js` | GET | public | Status page assets |
| `/api/status` | GET | public | Status payload as JSON (used by the page and by scrapers) |
| `/alert-preview` | GET | public | Renders one alert mail; never sends anything |
| `/run` | POST | **Bearer token** | Runs one round of probes and returns the fresh status |
| `/alert-test` | POST | **Bearer token** | Really sends one alert through the configured channel |
| `/daily-checks` | POST | **Bearer token** | Runs the daily checks now and returns each step's result; **really sends alerts** |

## STATUS_TOKEN

`/run`, `/alert-test` and `/daily-checks` are operator write endpoints and all
require `Authorization: Bearer $STATUS_TOKEN`. `/run` writes D1 rows (looping it
can burn the free-plan daily write quota) and `/alert-test` / `/daily-checks` send
real alerts, so none of them may stay open on a Worker that is reachable from the
public internet.

The check fails closed: with no `STATUS_TOKEN` bound, every call to those
endpoints returns 401 regardless of the header. That is deliberate, and it means:

> **After deploying this Worker you must run `wrangler secret put STATUS_TOKEN`,
> otherwise `/run` and `/alert-test` keep returning 401 forever.**

Local copy of the token lives in `secrets/webauthn.env` (git-ignored, never
committed). Create or rotate it with:

```sh
# 1. write the secret into the Worker (reads the credential from secrets/webauthn.env)
cd ops/status-worker
CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' ../../secrets/webauthn.env | tail -1)" \
CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' ../../secrets/webauthn.env | tail -1)" \
  /tmp/wrangler-env/node_modules/.bin/wrangler secret put STATUS_TOKEN --config wrangler.toml

# 2. keep the same value locally (append or replace the STATUS_TOKEN= line)
```

Smoke test after a deploy:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://status.limooo.cn/run
# 401 without a token
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $STATUS_TOKEN" \
  -X POST https://status.limooo.cn/run
# 200 with the token
curl -s -o /dev/null -w '%{http_code}\n' https://status.limooo.cn/_health
# 200
```

The daily checks can be exercised without waiting for 03:47 UTC:

```sh
curl -s -H "Authorization: Bearer $STATUS_TOKEN" -X POST \
  https://status.limooo.cn/daily-checks
# {"runs":{"ok":true,"issues":0,"alerted":false},
#  "blocklist":{"ok":true,"issues":0,"alerted":false}}
# ok=false means "this step could not run" (missing secret, D1/API error), not
# "something is broken"; issues/alerted report what was found.
```

`/alert-test` has a second layer on top of the token: one call per client IP per
60 seconds (in-isolate map, best effort, `429` + `Retry-After` beyond that). The
`Authorization` header is checked first, so unauthenticated requests never reach
that map.

## Secrets

| Secret | Required for | Without it |
| --- | --- | --- |
| `STATUS_TOKEN` | `/run`, `/alert-test`, `/daily-checks` | those endpoints return 401 (fail closed) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | the blocklist-drift step | that step is skipped and logged (fail open, no alert) |
| `ALERT_TO`, `ALERT_FROM` | any alert reaching a human | alerts are logged only |

`CLOUDFLARE_API_TOKEN` only needs read access to the `limooo_blocklist` IP List
(`Account > Account Rulesets > Read` or the equivalent). It is the same value the
sync Worker uses; this check never writes, never creates the list and never issues
`bulk_operations`.

## Deploy

```sh
bash ops/deploy.sh --worker=status-worker
```

The token is a Worker secret, not a `[vars]` entry: environment variables in
`wrangler.toml` are public and are wiped on some deploy paths, secrets are not.
