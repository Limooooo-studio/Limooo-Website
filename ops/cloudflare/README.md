# Limooo Cloudflare resource inventory

This directory is the declarative description of Limooo's Cloudflare resources, used
for deploys, rollbacks and external audits. Real tokens, secrets and reproducible IDs
are **not** written here; they come from the sources listed below.

| Resource | Name / type | Source of truth | Notes |
| --- | --- | --- | --- |
| Pages project | `limooo` | `site/wrangler.toml` | Build output `public`, serves `limooo.cn` and its subdomains |
| Pages Functions | `functions/**` | Git | Gate, login, Apple Account, visitor stats, Ray lookup |
| D1 database | `DB` binding | `site/wrangler.toml` (`database_id`) | Shared by Pages and the cron Workers |
| D1 migrations | `ops/migrations/*.sql` | Git | Entry point `ops/migrate_d1.sh`; `018_worker_runs.sql` / `019_worker_runs_dry_run.sql` hold the Worker run history |
| Worker: probes / status page | `limooo-status` | `ops/status-worker/wrangler.toml` | Probes every minute + 10 s re-check after down; `status.limooo.cn`; D1 retention **and the daily checks** (run history + blocklist invariant) daily at 03:47 |
| Worker: blocklist sync | `limooo-blocklist-sync` | `ops/sync-worker/wrangler.toml` | Daily 03:30, D1 active rows -> Cloudflare IP List; run history + `GET /?health=1` (see "Blocklist chain") |
| Worker: image watermark | `image-watermark` | `ops/image-watermark/wrangler.toml` | `image.limooo.cn/*` normalising proxy, `/portfolio/*` always returns the watermark (A2) |
| Worker: D1 archive | `limooo-d1-archive` | `ops/d1-archive/wrangler.toml` | Daily 00:00: archive of the previous UTC day into `limooo-analytics/` **plus** the configuration/schema snapshot into `backup/`; run history + `GET /?health=1` (see "Worker run history" and "Disaster-recovery snapshot") |
| R2 private bucket (originals) | `limooo-originals` | `ops/upload_originals.sh` | After A2 the portfolio originals live only locally + in this private bucket, never in Pages |
| R2 bucket (fonts) | `limooo-fonts` | `ops/fonts/README.md` | Public gate-font subset at `fonts.limooo.cn` |
| WAF IP List | `limooo_blocklist` | `ops/sync-worker` | Cloudflare List, referenced by WAF rules |
| DNS zone | `limooo.cn` | Cloudflare Dashboard | CNAMEs to `limooo.pages.dev`, see AGENTS.md |
| WAF rules | custom rules | Cloudflare Dashboard | `ip.src in $limooo_blocklist`, low-risk `js_challenge`; the custom-firewall phase is currently **empty**, and `ops/waf/rules.snapshot.json` is a refresh-time mirror of that empty phase (rules removed in the Dashboard live only in git history) |
| Cache Rules | `Limooo public cache` | Cloudflare API / Dashboard | Public HTML 300 s; `/static` and favicon 1 year |
| Zone settings | `limooo.cn` settings | Cloudflare Dashboard | HSTS/HTTPS enforcement, minimum TLS, Security Level, Web Analytics injection. `ops/zone-settings.snapshot.json` + `ops/zone_settings.py` pin the externally observable ones (see below) |

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

## Zone settings (`ops/zone-settings.snapshot.json`)

Zone-level settings change externally observable behaviour — whether `http://` redirects,
the minimum TLS version, whether Cloudflare injects its Web Analytics beacon — yet nothing
in this repository pinned them, so a Dashboard change could alter the live site with no
reviewable diff.

`ops/zone_settings.py` is the read-only counterpart to `ops/waf_rules.sh`:

```
python3 ops/zone_settings.py --dry-run    # offline: print the committed snapshot
python3 ops/zone_settings.py --show       # live: print current values, write nothing
python3 ops/zone_settings.py --snapshot   # live: refresh the snapshot, print what changed
```

The snapshot covers the keys in `SNAPSHOT_KEYS` (26 settings: transport, TLS, caching,
hotlink and bot-protection switches). It records `value` and `editable` per key, so a
plan-gated or renamed setting shows up as `unavailable` instead of vanishing.
`tests/test_zone_settings.py` fails if the snapshot drifts from `SNAPSHOT_KEYS` or if a
key the review logic guards disappears.

`--show` and `--snapshot` print a `<- review` note when a setting holds the *unwanted*
value (for example `ssl = flexible`, `development_mode = on`). They deliberately do not
flag correct values: the first draft flagged `always_use_https=on`, which is how a review
note turns into noise.

**One open item**: `security_level` is `essentially_off`, which disables Cloudflare's
threat score, IP reputation and Browser Integrity Check for the whole zone. The Worker
gate and the `blocked_ips` blocklist remain the only filters, and no record anywhere says
this was deliberate. Flagged in `## Open items / external confirmations`.

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

**This check also runs by itself.** `ops/status-worker` performs the same
comparison once a day inside its `47 3 * * *` task (TypeScript -- a Worker has no
python): `SELECT cidr FROM blocked_ips WHERE active = 1` (one indexed row) against
one page of IP List items, alerted only when `to_add`/`to_remove` is non-empty. The
script stays the manual entry point -- it can `--record`, prints the full delta and
handles paging the same way -- and both sides use one definition of the invariant
(the `/32` and `/128` normalisation is duplicated in `ops/status-worker/src/blocklist.ts`
on purpose; change one, change the other). Missing `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` on the status Worker is a logged skip, never an alert.

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
| `job` | `blocklist_sync` / `d1_archive` / `config_backup` (cron Workers) or `blocklist_sync_check` (`ops/check_blocklist_sync.py --record`). `d1_archive` and `config_backup` are the two stages of the same cron run and are recorded separately on purpose: `?health=1` reports one row per job, so "the archive is fine" cannot hide "the snapshot has been failing for a week" |
| `started_at` / `finished_at` | UTC epoch seconds; `finished_at` is NULL while a run is in flight |
| `outcome` | `running`, `ok`, `skipped` (no credentials), or `failed` |
| `added` / `removed` | Delta of that run. `d1_archive` puts the archived row total in `added`; `config_backup` puts the **measured D1 rows read** in `added` (its cost) and the number of R2 objects deleted by rotation in `removed` |
| `error` | Failure text, verbatim |
| `dry_run` | 1 = the run only computed the diff and sent no write request (`?dry-run=1`); 0 = a real sync. Added by `019_worker_runs_dry_run.sql`, because otherwise a rehearsal is indistinguishable from a sync that really ran -- the exact question this table exists to answer |

Both Workers also emit a structured single-line JSON log with `outcome:"failed"` on
failure, so `wrangler tail` and the Workers log panel can be searched for it. The
Worker hot paths (sync, archive) only ever **write** to this table; the reads happen in
the `?health=1` endpoint, in the operator script and in the daily check below, which
keeps the D1 read budget untouched (see AGENTS.md "D1 read budget").

**Somebody is now watching.** A record nobody reads is not visibility. Since the
daily checks landed in `ops/status-worker`, cron failures no longer just sit in the
table: `limooo-status` reads the latest row per job at 03:47 UTC -- after the archive
(`0 0 * * *`) and the sync (`30 3 * * *`) have both recorded their run -- and pushes
**one** alert through the normal channel (webhook -> Email binding -> SMTP) whenever
the outcome is not `ok`/`skipped`, or a row is stuck in `running` for more than two
hours. Cost is one index seek per job per day (`idx_worker_runs_job_started`,
measured `rows_read=2` for two jobs); this table is never read from the every-minute
probe cron, and adding it to the status page was rejected on purpose (that page is
re-rendered every minute per language, which would turn a 2-row read into thousands
of rows per day). `POST /daily-checks` on `status.limooo.cn` runs the same check on
demand.

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

Both return `{ ok, job, lastRun }`; the archive Worker also returns
`backup: { job: "config_backup", lastRun }`, because both stages of its cron need to be
visible from one call. `GET /` on the sync Worker still triggers a sync
and keeps its original `{ ok, toAdd, toRemove }` shape (the `.zshrc` helper
`_limooo_sync_cf` depends on it); `?dry-run=1` is unchanged. The archive Worker
answers 404 for anything except `?health=1` -- it exists only so a failure becomes
visible, never to be triggered over HTTP.

## Disaster-recovery snapshot (`backup/`)

Until 2026-10-11 the same D1 database had only two automatic paths: this Worker's
`analytics/YYYY_MM_DD/` archive (four analytics tables, previous UTC day) and the
retention job in `ops/status-worker`. **Neither covered a single configuration table**, so
a full-database loss would have taken `blocked_ips` (the authoritative block list),
`apple_accounts`, `auth_credentials`, `schema_version` (migration bookkeeping) and every
`CREATE TABLE` with it. The only other route was a hand-run export, and the newest of
those was 2026-09-26 -- a manual path nobody runs is not a path.

The daily 00:00 cron therefore has a **second stage**. It is deliberately a separate
`worker_runs` job (`config_backup`, not a re-labelled `d1_archive`), because
`GET /?health=1` reports one row per job: a shared job value would let "the archive is
fine" hide "the snapshot has been failing for a week".

### What it writes

One prefix per UTC **run** day (not per data day):

```
backup/2026_10_10/ddl.sql               replayable skeleton: every CREATE TABLE / INDEX
backup/2026_10_10/schema.jsonl.gz       every sqlite_master row verbatim (lossless)
backup/2026_10_10/manifest.json         per-table row counts, byte sizes, gaps, restore hints
backup/2026_10_10/<table>.jsonl.gz      one object per table below
```

12 objects per day. Measured on 2026-10-10: 12 objects / 22,867 bytes in total.

Rows are JSONL -- one JSON object per line -- gzipped, values taken verbatim from D1's
response objects. That is what keeps `active` an integer 0/1, keeps epoch timestamps
integers, and keeps `NULL` distinguishable from `''`.

`ddl.sql` is the *replayable* subset of `sqlite_master`: `sqlite_sequence` (a reserved
name; SQLite creates it itself for `AUTOINCREMENT`) and `_cf_KV` (Cloudflare-managed;
D1 rejects reads and writes with `SQLITE_AUTH`, code 7500) are left out but **listed in
the file header**, and both are kept verbatim in `schema.jsonl.gz` so nothing is lost.

### Tables in and out

| Table | Rows (2026-10-10) | Why |
| --- | --- | --- |
| `schema_version` | 19 | `migrate_d1.sh` skips already-applied files by these rows |
| `blocked_ips` | 83 | authoritative block list; `data/blocklist.txt` is only a snapshot of it |
| `apple_accounts` | 5 | account records, copied verbatim, never decrypted |
| `auth_credentials` | 1 | pbkdf2 hashes and lockouts, copied verbatim |
| `probes` / `probe_state` | 3 / 3 | probe definitions and alert state |
| `retention_state` | 5 | retention bookkeeping per bucket |
| `blocklist_audit` | 192 | the rollback basis for every block/unblock |
| `worker_runs` | 6 | whether the cron jobs actually ran |

Total **321 data rows + 107 `sqlite_master` rows = 428 rows read per run**, measured from
`meta.rows_read` (the sum is recorded as `d1_rows_read` in `manifest.json` and as `added`
on the `config_backup` row of `worker_runs`). Against the 5,000,000 rows/day free-tier
budget that is 0.009%, and it stays inside the "single-digit hundreds of rows" rule.

Deliberately **not** read, with the reason recorded in `manifest.json` next to the data:

- `visitors` (~13.9k rows) -- legacy VPS-era table with plaintext IPs; no code has read it
  since the 2026-09-17 edge migration, and copying it would create a second store of
  plaintext IPs.
- `visitors_daily` (~11.3k rows) -- derived aggregate, rebuilt by
  `ops/prune_d1.py --mode aggregate` from `visitors_v2` + `visitor_rollups`.
- `visitor_rollups`, `visitors_v2`, `ray_log_v2`, `events` -- already archived daily into
  `analytics/` by this same Worker.
- `heartbeats`, `probe_uptime_daily`, `ray_log`, `gate_failures`, `auth_sessions`,
  `_cf_KV` -- bulk telemetry, superseded tables, self-healing counters, re-loginable
  sessions, and a platform-internal table.

`visitors`, `visitors_daily` and `probe_uptime_daily` are the three places where this
snapshot is knowingly not a full backup; each one is listed with its reason in
`manifest.json`.

Two of the included tables grow without bound (`worker_runs` by one row per Worker run,
`blocklist_audit` by one row per block/unblock), so the daily read cost creeps upward.
`d1_rows_read` is in every manifest, which makes the drift a number rather than a guess;
if it ever approaches ~2,000, window those two tables instead of dropping the snapshot.

### Retention: `backup/` rotates, `analytics/` does not

At the end of a run the stage keeps the newest **14** `backup/YYYY_MM_DD/` prefixes and
deletes older ones **as whole snapshots** -- never object by object, which could leave a
`ddl.sql` with no rows beside it. Rotation is time-based rather than
completeness-based: a day whose table failed still counts as a day, otherwise a
permanently broken table would pin the bucket to unbounded growth. What that day actually
contains is in its `manifest.json` and in the `failed` run record.

`analytics/` is untouched by this, and structurally so:

1. the directory listing is issued with `prefix: "backup/"`, so R2 cannot return an
   `analytics/` prefix at all;
2. every key is re-checked against `isBackupKey()` immediately before the delete call;
3. only `backup/YYYY_MM_DD/`-shaped prefixes rotate, so anything hand-placed under
   `backup/` (`backup/notes.txt`, `backup/manual/`) is never auto-deleted.

`backup/` and `analytics/` also differ in meaning, not just in name:

| | `analytics/YYYY_MM_DD/` | `backup/YYYY_MM_DD/` |
| --- | --- | --- |
| Day means | the UTC day the **data** belongs to (yesterday) | the UTC day the **snapshot** was taken (today) |
| Content | 4 analytics tables, that day's rows only | DDL + 9 configuration/small tables, current state |
| Retention | none in R2 (D1 prunes the source tables) | newest 14 prefixes, older ones deleted |
| Purpose | investigate a day after the detail left D1 | rebuild the database |

One deliberate difference in the object metadata: `analytics/` objects carry
`contentEncoding: gzip`, and both the R2 REST API and `wrangler r2 object get` then
**silently inflate** them on download (measured: a 624-byte object arrives as 1,290 bytes
of plain JSONL under a `.jsonl.gz` name). `backup/` objects declare
`contentType: application/gzip` with no `contentEncoding`, so the bytes that arrive are
the bytes that were stored -- which is the only thing that makes a restore script work.

### Restoring from a snapshot

Replace `<database>` with `limooo` (or the D1 database name you are restoring into). The
target should be a **fresh** database; the rendered SQL uses plain `INSERT`.

```sh
DAY=2026_10_10
DEST=/tmp/limooo-restore-$DAY
mkdir -p "$DEST"

# 1. download the day (12 objects; the table names are the ones listed in the table above)
for t in schema_version blocked_ips apple_accounts auth_credentials probes \
         probe_state retention_state blocklist_audit worker_runs; do
  wrangler r2 object get "limooo-analytics/backup/$DAY/$t.jsonl.gz" --remote --file "$DEST/$t.jsonl.gz"
done
wrangler r2 object get "limooo-analytics/backup/$DAY/ddl.sql"        --remote --file "$DEST/ddl.sql"
wrangler r2 object get "limooo-analytics/backup/$DAY/schema.jsonl.gz" --remote --file "$DEST/schema.jsonl.gz"
wrangler r2 object get "limooo-analytics/backup/$DAY/manifest.json"  --remote --file "$DEST/manifest.json"

# 2. check what you got before touching anything (row counts, gaps, byte sizes)
cat "$DEST/manifest.json"

# 3. render DDL + INSERTs into one replayable file
python3 ops/d1-archive/restore.py --dir "$DEST" --out "$DEST/restore.sql"

# 4. apply it
wrangler d1 execute <database> --remote --file "$DEST/restore.sql"

# 5. verify
wrangler d1 execute <database> --remote \
  --command "SELECT COUNT(*) FROM blocked_ips; SELECT COUNT(*) FROM schema_version"
```

`restore.py` accepts gzip or already-inflated JSONL (it sniffs the gzip magic bytes),
refuses to render a snapshot whose columns are inconsistent between lines, and reports
any table object that is missing instead of quietly skipping it. To re-apply data on top
of an existing database use `--data-only --replace`; to emit only INSERTs, `--data-only`.

Because the snapshot only holds the tables listed above, a **full** point-in-time copy
still needs `wrangler d1 export <database> --remote` before a risky migration (see
"Migration and rollback"); the snapshot is what you have when nobody ran that.

### Failure visibility

The stage is a separate `worker_runs` job with the same structured single-line JSON log as
the rest of the Worker: `{"event":"config_backup","job":"config_backup","outcome":"failed",...}`
on `console.error`, searchable from `wrangler tail` and the Workers log panel. Both stages
run inside their own `try`/`catch` in `scheduled()`: a snapshot failure never fails the
archive, and an archive failure never skips the snapshot. One table failing does not
discard the other eight -- it is recorded in `manifest.json`, in the run row and in the
log, and rotation still runs so a bad table cannot pin the bucket.

## Migration and rollback

1. Back up D1 before a change: `wrangler d1 export <database> --remote` (record it in
   `docs/parallel-actions.md`). For a schema/configuration-only rollback the daily
   `backup/` snapshot above is usually enough and needs no manual step.
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
- **`security_level` is `essentially_off`** (measured 2026-10-11, `python3 ops/zone_settings.py
  --show`). That disables Cloudflare's threat score, IP reputation and Browser Integrity
  Check for the whole zone, leaving the Worker gate and the `blocked_ips` blocklist as the
  only filters. No record anywhere says this was deliberate, and no evidence of active
  attack traffic was found either (the analytics endpoint is not readable with the current
  API token). Needs a human decision: raise it, or record why it is off.
- `identity.limooo.cn` still has a proxied `CNAME` to `limooo.pages.dev` but returns 404,
  and nothing in the repository or the docs references it (it is an authentik-era
  leftover). Dead hostname; removal is a Dashboard action.
