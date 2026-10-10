# Limooo Cloudflare resource inventory

This directory is the declarative description of Limooo's Cloudflare resources, used
for deploys, rollbacks and external audits. Real tokens, secrets and reproducible IDs
are **not** written here; they come from the sources listed below.

| Resource | Name / type | Source of truth | Notes |
| --- | --- | --- | --- |
| Pages project | `limooo` | `site/wrangler.toml` | Build output `public`, serves `limooo.cn` and its subdomains |
| Pages Functions | `functions/**` | Git | Gate, login, Apple Account, visitor stats, Ray lookup |
| D1 database | `DB` binding | `site/wrangler.toml` (`database_id`) | Shared by Pages and the cron Workers |
| D1 migrations | `ops/migrations/*.sql` | Git | Entry point `ops/migrate_d1.sh`; `018_worker_runs.sql` holds the Worker run history |
| Worker: probes / status page | `limooo-status` | `ops/status-worker/wrangler.toml` | Probes every minute + 10 s re-check after down; `status.limooo.cn`; D1 retention daily at 03:47 |
| Worker: blocklist sync | `limooo-blocklist-sync` | `ops/sync-worker/wrangler.toml` | Daily 03:30, D1 active rows -> Cloudflare IP List; run history + `GET /?health=1` (see "Blocklist chain") |
| Worker: image watermark | `image-watermark` | `ops/image-watermark/wrangler.toml` | `image.limooo.cn/*` normalising proxy, `/portfolio/*` always returns the watermark (A2) |
| Worker: D1 archive | `limooo-d1-archive` | `ops/d1-archive/wrangler.toml` | Daily 00:00 archive of the previous UTC day into `limooo-analytics`; run history + `GET /?health=1` (see "Worker run history") |
| R2 private bucket (originals) | `limooo-originals` | `ops/upload_originals.sh` | After A2 the portfolio originals live only locally + in this private bucket, never in Pages |
| R2 bucket (fonts) | `limooo-fonts` | `ops/fonts/README.md` | Public gate-font subset at `fonts.limooo.cn` |
| WAF IP List | `limooo_blocklist` | `ops/sync-worker` | Cloudflare List, referenced by WAF rules |
| DNS zone | `limooo.cn` | Cloudflare Dashboard | CNAMEs to `limooo.pages.dev`, see AGENTS.md |
| WAF rules | custom rules | Cloudflare Dashboard | `ip.src in $limooo_blocklist`, low-risk `js_challenge`; the custom-firewall phase is currently **empty** and `ops/waf/rules.snapshot.json` keeps the historical rule set for rebuilds |
| Cache Rules | `Limooo public cache` | Cloudflare API / Dashboard | Public HTML 300 s; `/static` and favicon 1 year |

## Dashboard-only resources (this repository is not fully reproducible)

Everything below exists **only in the Cloudflare Dashboard**. The files listed above
declare the Worker code and its bindings, but they do **not** declare the routes, so a
fresh `wrangler deploy` will not recreate them:

- Worker **custom domains and routes**: `image.limooo.cn/*` -> `image-watermark`,
  `status.limooo.cn/*` -> `limooo-status`, plus the `sync-worker` route. They live
  under Workers & Pages -> (worker) -> Settings -> Domains & Routes and are
  deliberately absent from every `wrangler.toml` (`ops/image-watermark/wrangler.toml`
  says so explicitly): a `routes` block would make each deploy rewrite the live route
  set, which this repository cannot diff or roll back.
- Pages **custom domains** (`limooo.cn`, `www`, `services`, `contact`, `visitor`,
  `account`, `admin`, ...) and their certificates.
- **DNS records** in `limooo.cn`.
- **WAF custom rules** and the access rules for the `limooo_blocklist` IP List.
- **Cache Rules** and any manual edge cache purge.

Treat the Dashboard as authoritative for those; this file is the inventory that makes
them traceable, not a reproducible manifest.

## Pages environment variables (key names only, never values)

Configured in the Pages project under `Environment variables -> Encrypt (Secret)`:

- `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`
- `GATE_HMAC_KEY`, `SESSION_HMAC_KEY`
- `ACCESS_TEAM_DOMAIN`, `ACCESS_ADMIN_AUDS`, `ACCESS_VIEWER_AUDS`
- `APPLE_ACCOUNT_ENCRYPTION_KEY`, `VISITOR_IP_KEY`
- `OBSERVABILITY_HMAC_KEY`

Local development copies `.dev.vars.example`; production values are read from the
local `secrets/webauthn.env` and the Pages project secrets (never committed, never
echoed). There is no server-side credential source any more.

## Blocklist chain

Banning is carried by three layers, all driven by the same D1 table:

| Layer | Source | What it does |
| --- | --- | --- |
| Authority | D1 `blocked_ips` | The only authoritative record; `active = 1` means banned, `active = 0` is a soft-delete tombstone |
| Edge | Cloudflare IP List `limooo_blocklist` | Written by `ops/sync-worker` (cron `30 3 * * *`); referenced by the WAF rules |
| Worker | `functions/_lib/gate.ts` | `BLOCKED_LIST_SQL` also filters `WHERE active = 1`, so both layers agree; returns 403 |

`data/blocklist.txt` is a snapshot for auditing only. The WAF custom-firewall phase is
currently **empty** (see the table above), so the IP List is the only edge-level
enforcement.

Both layers read `active = 1`, which makes "the IP List is empty" ambiguous: it can
mean "nothing is banned" (correct) or "the sync silently stopped writing" (a fault).
Until migration 018 there was no way to tell the two apart from the outside. Now
`ops/check_blocklist_sync.py` is the diagnostic entry point:

```sh
python3 ops/check_blocklist_sync.py            # text report, exit 1 on drift
python3 ops/check_blocklist_sync.py --json     # one JSON object, for cron/alerting
python3 ops/check_blocklist_sync.py --record   # also log this check into worker_runs
```

It prints the desired set (D1 `blocked_ips` with `active = 1`), the actual set (the
Cloudflare IP List API), the delta (`to_add` / `to_remove`), and the last recorded run
per job. **Exit 0** means both layers agree and every reported job finished `ok` /
`skipped`; **exit 1** means drift or a failed job; **exit 2** means the check itself
could not complete (credentials, D1, Cloudflare) and says nothing about drift.

Cost: two reads, both indexed and tiny -- `SELECT cidr FROM blocked_ips WHERE
active = 1` (`idx_blocked_ips_active`) and one `LIMIT 1` per job on `worker_runs`
(`idx_worker_runs_job_started`). It never touches the large tables. The script is
read-only: it only ever issues `GET` on the Cloudflare side, and `--record` (opt-in)
appends at most one row to `worker_runs`.

**Not implemented on purpose.** `ops/sync-worker` is the only job that compares the
two layers. A Cloudflare-side change that silently drops entries (account migration,
API regression, someone editing the list by hand) still leaves both sides "consistent"
from D1's point of view, so this script would report `to_add=0 to_remove=0` while the
ban is gone. The run history fixes the "did the sync run at all" question; it does not
make the IP List self-verifying.

## Worker run history (`worker_runs`, migration 018)

Both cron Workers used to call `ctx.waitUntil(asyncWork(env))`, so a rejected promise
was swallowed and the Cloudflare cron panel still showed the run as fine. A sync or
archive failure produced no record anywhere. Migration `018_worker_runs.sql` closes
that gap:

| column | meaning |
| --- | --- |
| `job` | `blocklist_sync` / `d1_archive` (cron Workers) or `blocklist_sync_check` (`ops/check_blocklist_sync.py --record`) |
| `started_at` / `finished_at` | UTC epoch seconds; `finished_at` is NULL while a run is in flight |
| `outcome` | `running`, `ok`, `skipped` (no credentials), or `failed` |
| `added` / `removed` | Delta of that run (`added` also carries the row total for `d1_archive`) |
| `error` | Failure text, verbatim |

Both Workers also emit a structured single-line JSON log with `outcome:"failed"` on
failure, so `wrangler tail` and the Workers log panel can be searched for it. The
Worker hot paths (sync, archive) only ever **write** to this table; the reads happen in
the `?health=1` endpoint and in the operator script, which keeps the D1 read budget
untouched (see AGENTS.md "D1 read budget").

Health endpoints (both require `Authorization: Bearer <SYNC_TOKEN>` and fail closed
with 401 when the secret is unset):

```sh
# blocklist sync: last run only, does NOT trigger a sync
curl -H "Authorization: Bearer $SYNC_TOKEN" \
  'https://limooo-blocklist-sync.limooo.workers.dev/?health=1'

# d1 archive: last run only, does NOT archive anything
curl -H "Authorization: Bearer $SYNC_TOKEN" \
  'https://limooo-d1-archive.limooo.workers.dev/?health=1'
```

Both return `{ ok, job, lastRun }`. `GET /` on the sync Worker still triggers a sync
and keeps its original `{ ok, toAdd, toRemove }` shape (the `.zshrc` helper
`_limooo_sync_cf` depends on it); `?dry-run=1` is unchanged. The archive Worker
answers 404 for anything except `?health=1` -- it exists only so a failure becomes
visible, never to be triggered over HTTP.

## Migration and rollback

1. Back up D1 before a change: `wrangler d1 export <database> --remote` (record it in
   `docs/parallel-actions.md`).
2. Preview: `bash ops/migrate_d1.sh --dry-run`.
3. Apply: `bash ops/migrate_d1.sh --remote`.
4. Roll back: restore from the backup, then re-run `migrate_d1.sh --remote`. Applied
   code versions are not reverted automatically; pair the rollback with a Git commit.

## Deploy order

```sh
# 1. build and validate (no deploy)
bash ops/pages_deploy.sh --build-only

# 2. preview the migrations and the Cloudflare commands
bash ops/pages_deploy.sh --dry-run
bash ops/workers_deploy.sh --dry-run

# 3. the real deploys (need credentials; book them in docs/parallel-actions.md)
bash ops/pages_deploy.sh
bash ops/workers_deploy.sh
```

## Cache Rules

`Limooo public cache` exists in the `limooo.cn` zone. **Since 2026-09-26 both HTML
cache rules are disabled** (`Cache public HTML for returning visitors`,
`Cache images gallery page for returning visitors`, `enabled=false`): their
`cache_key` was empty, so the edge cached by URL only, while the public page language
is decided by the `user_lang_preference` cookie. The first visitor's language was then
served to everyone at the same URL, and switching language still returned the old one.
The free plan does **not** support a custom cache key (it fails with
`not entitled to use the custom cache key override`), so the cookie cannot be part of
the key; the rules were disabled and the Worker's Cache API now buckets by `lang`
(`cachedPageAsset` in `functions/_middleware.ts`) with
`Vary: Accept-Language, Cookie`. The page TTL is still 300 s, so behaviour is unchanged.

Historical records:

- Public HTML: used to match `/`, `/services`, `/contact` on `limooo.cn`,
  `services.limooo.cn`, `contact.limooo.cn` when the request carried the
  `user_lang_preference` cookie; edge/browser TTL 300 s.
- Static assets: used to match `/static/*` on the hosts above plus the main-site
  favicon and `limooo-xtext.svg`; edge/browser TTL 1 year.

> After A2, `/static/portfolio/**` is no longer a public image path (the originals
> were removed; only `/static/wm/portfolio/**` watermarks and
> `/static/portfolio/thumbs/**` thumbnails remain), but older deployments cached the
> clean originals with `immutable` (1 year). Switching to A2 therefore requires
> **purging the Cloudflare edge cache for `/static/portfolio/*` by hand**, otherwise
> the edge can keep serving the old clean originals.

The rules are managed through the Rulesets API phase
`http_request_cache_settings`; token permissions are documented by Cloudflare's Cache
Rules docs. Change or delete them in the Dashboard under `Rules -> Cache Rules` to
avoid fighting the Pages code.

## D1 retention and cleanup

The **owner of the retention policy is `ops/status-worker/src/retention.ts`**; it runs
on the Worker cron at 03:47. `ops/prune_d1.py` is the manual operator entry point and
reads the same windows from that file (it fails loudly if the two ever disagree):

| Table | Window | Timestamp column | Notes |
| --- | --- | --- | --- |
| `ray_log_v2` | 7 days | `ts` | Per-request edge log detail |
| `visitors_v2` | 30 days | `ts` | Visitor detail |
| `visitor_rollups` | 30 days | `last_ts` | Hourly rollups (HMAC `ip_hash` + Fernet `ip_enc`) |
| `heartbeats` | 30 days | `ts` | Probe heartbeats, 3 rows per minute |
| `auth_sessions` | 60 days | `exp` | Must stay **longer** than `session_ttl_seconds` (30 days), otherwise live sessions are deleted |
| `events` | 90 days | `ts` | Audit and operational events |
| `probe_uptime_daily` | 90 days | `day` | Daily uptime rollups (the status page reads at most 7 days) |
| `visitors_daily` | permanent | - | Daily aggregate; written by `ops/prune_d1.py --mode aggregate --apply` |

`visitors_daily` is only ever written for **complete UTC days** and upserted with
`ON CONFLICT ... DO UPDATE SET x = MAX(x, excluded.x)`, so re-running the aggregation
can never shrink a day that was already correct (docs/22 W7-5).

Production scheduling is entirely Worker Cron Triggers: probes every minute, retention
daily at 03:47 (`ops/status-worker`), blocklist sync daily at 03:30 (`ops/sync-worker`),
D1 archive daily at 00:00 (`ops/d1-archive`). There is no VPS crontab any more;
`install_retention_cron.sh` was deleted with the VPS. What each of those runs actually
did is recorded in `worker_runs` (see "Worker run history" above); failures are
retrievable from the Workers log as single-line JSON with `outcome:"failed"`.

### `ray_log_v2` `ip_hash` index: landed in migration 017

`ray_log_v2` used to have only a `ts` index, so `WHERE ip_hash = ...` -- used by
`ops/check_ip_rays.py` and `ops/check_visitor_id.py --requests` -- was a full scan of
the 7-day detail table, and mapping a plaintext IP to its hash decrypts every
`visitor_rollups.ip_enc` row. A troubleshooting script must not become the next D1
read incident, so those scripts print the query size before querying, and
`ops/check_ip_rays.py --hash <ip_hash>` skips the `ip_enc` scan entirely.

**Landed in `ops/migrations/017_ray_log_v2_ip_hash_index.sql`** (applied to production
on 2026-10-11 via `bash ops/migrate_d1.sh --remote`, `schema_version` key 17001):

```sql
CREATE INDEX IF NOT EXISTS idx_ray_log_v2_ip_hash_ts ON ray_log_v2 (ip_hash, ts DESC);
```

It is a retention-friendly composite index (the table is pruned by `ts`, so the index
stays small). Measured on production D1 (`ray_log_v2` = 2337 rows):

| query | before | after |
| --- | --- | --- |
| `WHERE ip_hash = ? ORDER BY ts DESC LIMIT n` | `SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts` | `SEARCH ray_log_v2 USING INDEX idx_ray_log_v2_ip_hash_ts (ip_hash=?)` |
| `WHERE ip_hash IN (...) ORDER BY ts DESC LIMIT n` | `SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts` | `SEARCH ray_log_v2 USING INDEX idx_ray_log_v2_ip_hash_ts (ip_hash=?)` |

`WHERE ray LIKE '...'` (`ops/check_ray_id.py`, `functions/api/ray/[id].ts`) still scans
`idx_ray_log_v2_ts`: the ray prefix is only known at runtime, so an index on `ray` would
not help -- `ray` is already the `PRIMARY KEY`, and the planner needs the leading column
to be constrained.

**Why `idx_ray_log_v2_host_ts` is still absent.** `005_retention.sql:33` creates it, but
`008_gate_failures.sql:23-25` deliberately drops it again ("the following indexes have no
production query using them, yet amplify every write"). That still holds: no query filters
`ray_log_v2` by `host` -- every `FROM ray_log_v2` site filters on `ts`, `ip_hash` or `ray`,
and `host` only appears in `SELECT` lists. Do not re-add it without a query that needs it.
Note that 005 cannot be "fixed in place": production records 005 as the legacy plain
version number `5`, so `migrate_d1.sh` skips the whole file (`skip (recorded legacy
version 5)`) -- an index added inside it would never run. Index changes need a new number.

## Open items / external confirmations

- The user decided not to restore the historical 1255 snapshots; the backups stay
  archived and are not imported into D1 or the CF List.
- Login is Cloudflare Access only; the authentik / Uptime Kuma entries are void since
  the VPS lease ended.
- WAF custom rules and DNS records should be changed through the Cloudflare API or the
  Dashboard; this file only keeps those states traceable.
- A2 image ownership is live: originals are private (`limooo-originals`), the public
  side serves only watermark variants and thumbnails.
