# status-worker

Cloudflare Worker behind `status.limooo.cn`: uptime probes, the public status page
and the alert channel that replaced Uptime Kuma.

- Cron `* * * * *` runs one round of probes and writes D1
  (`heartbeats`, `probe_state`, `probe_uptime_daily`).
- Cron `47 3 * * *` runs the D1 retention pass (`retention.ts`).
- A probe that crosses `FAIL_THRESHOLD` is handed to the `ProbeState` Durable
  Object, which re-checks it every `RETRY_INTERVAL_S` seconds and records recovery.
- Alerts go to `ALERT_WEBHOOK_URL` first (Feishu bot format by default) and fall
  back to the `EMAIL` binding; with neither configured they are only logged.

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

## STATUS_TOKEN

`/run` and `/alert-test` are operator write endpoints and both require
`Authorization: Bearer $STATUS_TOKEN`. `/run` writes D1 rows (looping it can burn
the free-plan daily write quota) and `/alert-test` sends a real alert, so neither
may stay open on a Worker that is reachable from the public internet.

The check fails closed: with no `STATUS_TOKEN` bound, every call to those two
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

`/alert-test` has a second layer on top of the token: one call per client IP per
60 seconds (in-isolate map, best effort, `429` + `Retry-After` beyond that). The
`Authorization` header is checked first, so unauthenticated requests never reach
that map.

## Deploy

```sh
bash ops/deploy.sh --worker=status-worker
```

The token is a Worker secret, not a `[vars]` entry: environment variables in
`wrangler.toml` are public and are wiped on some deploy paths, secrets are not.
