# Limooo

A fully serverless personal website and admin system running at [limooo.cn](https://limooo.cn). Public pages, the human-verification gate, the visitor panel, the Apple Account manager, monitoring and the status page all run on Cloudflare (Pages Functions, Workers, D1, R2).

## Features

- **Public pages**: Home, Services, Contact, Portfolio — pre-rendered in 4 languages with dark/light theme switching
- **Human verification**: the Turnstile gate page is rendered **in place** at the requested URL (no cross-domain hop) on every host — see [Gate behavior](#gate-behavior)
- **Visitor panel** (`visitor.limooo.cn`): Pages Function + D1 analytics; shows a hashed visitor identifier (no raw IP in list APIs), country, ISP/ASN where available, status-code distribution, and is login-protected
- After the first load, visitor status chips filter locally with no new `/api/visitors` request; the API still accepts `?status=<3-digit>` for deep links.
- **Apple Account manager** (`account.limooo.cn/apple`): Pages Function + D1 CRUD with drag-and-drop ordering; passwords are stored encrypted with Fernet, the list shows only masked passwords, with temporary plaintext reveal
- **Auth & roles**: Cloudflare Access is the sole identity source; the Worker self-verifies the Access JWT and maps AUD → admin (read-write) / viewer (read-only)
- **Monitoring**: the `limooo-status` Worker probes HTTP/D1 targets every minute, re-checks every 10s while a probe is down, and stores results in D1; alerts go out over a webhook (Email binding as fallback)
- **Status page** (`status.limooo.cn`): server-rendered from D1 by the same Worker, with per-day uptime taken from the `probe_uptime_daily` rollup
- **Automatic IP blocking**:
  - D1 `blocked_ips` is the authority; `sync-worker` mirrors active rows to a Cloudflare IP List for edge interception (no origin, so no ipset/iptables)
  - Application-layer global filter as a fallback — banned IPs get a direct 403
- **Unified redirect page** (`redirect.limooo.cn/?to=<https-url>`, `/r` also accepted): shows an interstitial before redirecting to any HTTPS destination
- **Portfolio image handling**: originals are never published; only watermarked full images (`image.limooo.cn/portfolio/*`) and clean thumbnails are public

## Tech stack

| Layer | Technology | Runs on |
| --- | --- | --- |
| Public pages, gate, visitor panel, Apple Account manager, status page | Pages Functions (`functions/`) + pre-rendered static HTML | Cloudflare edge |
| Data | D1 (visitor analytics, blocklist, Apple Account accounts, auth sessions, probes/heartbeats) | Cloudflare |
| Human verification | Cloudflare Turnstile, gate page rendered in place | Cloudflare + browser |
| Auth | Cloudflare Access (Zero Trust JWT, self-verified by the Worker) | Cloudflare |
| Monitoring & retention | `ops/status-worker` (Cron Triggers + Durable Object alarms) | Cloudflare Workers |
| D1 archive | `ops/d1-archive` (daily cron) | Cloudflare Workers |
| Blocklist sync | `ops/sync-worker` (daily cron → Cloudflare IP List) | Cloudflare Workers |
| Image watermarking | `ops/image-watermark` (path-normalizing proxy) | Cloudflare Workers |
| Static assets / originals backup | Pages asset server + private R2 bucket `limooo-originals` | Cloudflare |
| Deployment | `ops/deploy.sh` (git + `ops/pages_deploy.sh` + `ops/workers_deploy.sh`) | local |

## Project structure

```
├── src/
│   ├── config.py                                     # unified config: paths, languages, domains, DB/IP utils (consumes config-contract.json)
│   ├── auto_block.py                                 # manual blocklist.txt → D1 reconciliation (D1 is the authority)
│   ├── cidr.py                                       # CIDR parsing helpers
│   ├── portfolio.py                                  # portfolio image / thumbnail helpers
│   ├── render_app.py                                 # build-time read-only renderer used by src/build.py
│   ├── services_pricing.py                           # CSV-driven price list for services.limooo.cn
│   ├── build.py                                      # Pages static build (python3 src/build.py)
│   ├── static/                                       # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/                                    # Jinja2 page templates
├── README.md                                         # this file
├── LICENSE.md                                        # AGPL-3.0
├── LICENSE_zh_CN.md                                  # AGPL-3.0 (Simplified Chinese)
├── LICENSE_ja_JP.md                                  # AGPL-3.0 (Japanese)
├── LICENSE_ko_KR.md                                  # AGPL-3.0 (Korean)
├── config-contract.json                              # single source of domains / languages / cookies / TTLs
├── package.json                                      # npm scripts: build / test / typecheck
├── package-lock.json                                 # locked Node dependency tree (npm ci)
├── requirements.lock                                 # pinned Python dependencies (read by ops/build.sh)
├── wrangler.toml                                     # Cloudflare Pages project + D1 binding
├── tsconfig.json                                     # TypeScript config for functions/ and the Workers in ops/
├── vitest.config.ts                                  # vitest config (functions/**/*.test.ts)
├── pytest.ini                                        # pytest config (tests/)
├── pyproject.toml                                    # ruff / mypy config
├── .gitignore                                        # ignore rules shipped with the repository
├── .github/                                          # GitHub Actions workflows
│   └── workflows/
│       └── tests.yml                                 # CI: build, then typecheck / migrations / vitest / pytest
├── .githooks/                                        # git hooks (installed by ops/install_git_hooks.sh)
│   └── pre-push                                      # runs ops/ci_check.sh on the commit being pushed
├── .vscode/                                          # editor settings and recommended extensions
├── data/                                             # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt                                 # auditable snapshot of D1 blocked_ips (D1 is the sole authority)
│   └── whitelist.txt                                 # trusted ASNs (low-risk) + fully allowed IPs/CIDRs
├── secrets/                                          # secrets & certificates, git-ignored
│   ├── webauthn.env                                  # env file read by the deploy scripts
│   └── apple_account_encryption.key                  # Apple Account password encryption key
├── ops/                                              # deployment & ops tooling
│   ├── deploy.sh                                     # the single deploy entry point (commit/push + Pages + docs + Worker)
│   ├── build.sh                                      # Pages build: venv, contract checks, public/manifest.json
│   ├── pages_deploy.sh                               # Cloudflare Pages build + Wrangler deploy
│   ├── docs_deploy.sh                                # docs.limooo.cn build + deploy (VitePress → Pages project limooo-docs)
│   ├── docs_headers.py                               # generates the docs site `_headers` (CSP hashes + cache)
│   ├── ci_check.sh                                   # local replica of .github/workflows/tests.yml
│   ├── run-tests.sh                                  # test runner used locally
│   ├── install_git_hooks.sh                          # installs the pre-push hook
│   ├── readme_facts.py                               # re-reads the facts on this page (--check / --live)
│   ├── migrate_d1.sh                                 # D1 migrations (--dry-run / --remote)
│   ├── workers_deploy.sh                             # standalone Worker deploys
│   ├── export_d1.py                                  # unified D1 import SQL/JSON export (apple-account | blocklist)
│   ├── prune_d1.py                                   # manual D1 retention and aggregation (scheduled retention runs in status-worker)
│   ├── d1_client.py                                  # Cloudflare API client for D1
│   ├── upload_originals.sh                           # private R2 backup of portfolio originals
│   ├── security-headers.json                         # single source of the response-header baseline
│   ├── tailwind.config.js                            # Tailwind config for the prebuilt CSS
│   ├── check_config_contract.py / check_gate_trust.py / check_security_headers.py / check_ip_rays.py / check_ray_id.py / check_visitor_id.py
│   ├── migrations/                                   # D1 schema migrations
│   ├── waf/                                          # WAF rule snapshots
│   ├── cloudflare/                                   # Cloudflare resource inventory (declarative)
│   ├── email-templates/                              # transactional email framework + i18n copy
│   ├── fonts/                                        # gate-diagnostic font subset
│   ├── status-worker/                                # Worker: probes, status page, alerting, D1 retention
│   ├── image-watermark/                              # Worker: image.limooo.cn watermark normalizer
│   ├── d1-archive/                                   # Worker: D1 snapshot/archive (cron 00:00)
│   ├── sync-worker/                                  # Worker: D1 blocked_ips → Cloudflare IP List (cron 03:30)
│   ├── requirements.txt                              # Python dependencies
├── functions/                                        # Cloudflare Pages Functions
│   ├── _middleware.ts                                # gate/redirect/blocklist/visitors/ray orchestration (test: _middleware.test.ts)
│   ├── _lib/                                         # config, d1, cidr, gate, access, session, fernet, routing
│   ├── _data/                                        # generated i18n/runtime modules (do not hand-edit)
│   ├── api/                                          # apple-account, auth, i18n, ray, visitors endpoints
│   ├── types.d.ts                                    # shared Env / PagesFunction types
│   └── login.ts / logout.ts                          # Access login callback and logout (tests: *.test.ts)
├── tests/                                            # pytest suites + fixtures
├── locales/                                          # i18n / translation catalogs
├── public/                                           # Pages build output (git keeps only .gitkeep)
├── preview/                                          # local preview (build-generated; git keeps only .gitkeep)
└── docs/                                             # docs.limooo.cn VitePress root + services.limooo.cn price-list CSVs
```

## Quick start

```bash
# Install the Node dependencies pinned by package-lock.json
npm ci

# Build the static site (Python venv + contract checks + public/ + preview/)
npm run build
```

`npm run build` is `ops/build.sh`: it creates the build virtualenv `.venv-build`,
runs the contract checks and exports
`DYLD_LIBRARY_PATH=$(brew --prefix cairo)/lib` before rendering, so no manual
setup is needed. Running `python3 src/build.py` directly skips all three — it fails
with `RuntimeError: SVG watermarking requires cairosvg` unless you export that
Homebrew cairo path yourself.

For a clean VS Code experience, install the recommended extensions (Jinja, Pylance)
listed in `.vscode/extensions.json`; workspace settings associate Jinja templates so
HTML/CSS/JS diagnostics do not misread template syntax.

For a local preview of the generated site, build and open the output from `preview/`.

## Build, testing and deploy

For a clean local build, use the same dependency set as the deployment script:

```bash
cd site
npm ci
npm run build
```

`src/build.py` regenerates `public/<lang>/*.html`, `public/static/`,
`functions/_data/i18n.ts`, `functions/_data/runtime.ts` and `preview/`.
Do not hand-edit those outputs; change `locales/*.json`, templates or static
sources and rebuild. `src/static/tailwind.css` is the checked-in prebuilt
Tailwind output. `npm run build` uses `ops/build.sh`, which creates `.venv-build`
and generates `public/manifest.json` (build-artifact hash evidence).

Deploy only the Pages output with:

```bash
# build + validate only, no Cloudflare writes
bash ops/pages_deploy.sh --build-only

# build + validate + deploy Pages + smoke test (/_health must be 200)
bash ops/pages_deploy.sh

# full deploy: (1) commit (2) push (3) deploy Pages + docs
bash ops/deploy.sh --all
```

**Deploy entry points**: `ops/deploy.sh` is the single deploy entry point — commit +
push + Pages + docs, plus `--worker=<name>` for one standalone Worker;
`ops/pages_deploy.sh` handles build + Pages. `--dry-run` prints the plan without
writing to any remote.

By default `deploy.sh` is **quiet**: one status line per step, and a step's full log
is dumped only if that step fails. Add `--full` to stream everything (build manifest,
artifact count, wrangler upload progress). The flags and the steps are identical
either way — `--full` changes verbosity only.

Credentials are read from the local `secrets/webauthn.env` (never committed, never
echoed); there are no ssh / rsync / remote systemd steps.
`ops/migrate_d1.sh` and `ops/workers_deploy.sh` also support `--dry-run`.

Automated test entry points are provided:

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## Environment variables

Read from `secrets/webauthn.env` by the deploy scripts, not committed to Git. The Pages runtime has its own secret set (see the edge section below).

| Variable | Description |
| --- | --- |
| `GATE_HMAC_KEY` | HMAC-SHA256 key for the `__gate` cookie, minted and validated at the edge |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare API access for `ops/d1_client.py`, `ops/pages_deploy.sh` and `ops/workers_deploy.sh` |

Key material lives outside the repo; `apple_account_encryption.key` is the Fernet key
used for Apple Account passwords and the encrypted visitor IP column.

## Cron jobs

All scheduling lives on Cloudflare as Worker Cron Triggers declared in each Worker's
`wrangler.toml`. `python3 ops/readme_facts.py` re-reads this table, the retention
windows and every path in the tree below:

| Schedule | Worker | Job |
| --- | --- | --- |
| `* * * * *` | `ops/status-worker` | HTTP/D1 probes every minute; a Durable Object alarm re-checks every 10s while a probe is down, and alerts on state change |
| `47 3 * * *` | `ops/status-worker` | D1 retention (`src/retention.ts`): prunes `ray_log_v2` (7d), `visitors_v2` (30d), `visitor_rollups` (30d), `heartbeats` (30d), `events` (90d), `probe_uptime_daily` (90d) and `auth_sessions` (60d) |
| `30 3 * * *` | `ops/sync-worker` | Mirrors active D1 `blocked_ips` rows to the Cloudflare IP List `limooo_blocklist` |
| `0 0 * * *` | `ops/d1-archive` | D1 snapshot/archive run |

TLS certificates are issued and renewed by Cloudflare for the Pages custom domains.
`ops/migrate_d1.sh` and `ops/workers_deploy.sh` are manual, `--dry-run`-capable
maintenance entry points.

`python3 ops/readme_facts.py --check` re-reads the schedules, retention windows, TTLs
and directory tree from this repository and fails when this page drifts; `--live` reads
the deployed side (D1 counters, Pages hosts and secrets, DNS, WAF, Worker schedules)
from Cloudflare.

## Deployment

The deploy target is Cloudflare Pages (`limooo`) plus the standalone Workers, all
through the Cloudflare API. From the repository root:

```bash
cd site
bash ops/deploy.sh              # with no arguments = --all (full deploy, see below)
bash ops/deploy.sh --all        # commit + push + deploy Pages + docs
bash ops/deploy.sh --pages      # deploy the main Pages project only
bash ops/deploy.sh --docs       # deploy docs.limooo.cn only
bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker
bash ops/deploy.sh --all --full             # same, but stream every step's output
```

Running `ops/deploy.sh` with **no arguments is exactly `--all`**: commit + push +
Pages + docs, the "full deploy" contract. To ship only what is already committed
locally, pass `--pages` / `--docs` explicitly.

Output is quiet by default (one status line per step); add `--full` to watch the whole
process. `--dry-run` works with any combination of the flags above.

Credentials are read from the local `secrets/webauthn.env`; every step runs over the
Cloudflare API or Git.

### Docs site (docs.limooo.cn)

`site/docs/` is a **per-subdomain container**: `docs/` holds the docs.limooo.cn
VitePress root (one markdown file per page per language), `services/` holds the
services.limooo.cn price-list CSVs. The language code is the **last** URL segment and
content pages carry it explicitly (`/README/zh-cn`, `/README/en-us`); a suffix-less
`/README` 302s to `/README/zh-cn`, and the home page `/` is the one exception.

`.vitepress/rewrites.json` (beside the content) maps the markdown sources onto those suffixed
routes, and `.vitepress/config.mts` gives each page its own `lang` / `themeConfig`
through `additionalConfig`. Add a page by dropping a markdown file in each language
directory, plus a rewrites entry and a 302 in `public/_redirects` for the
suffix-less path — `ops/docs_check_output.py` fails the build if any markdown file
has no HTML.

The site is built with VitePress from the fork `Limooooo-Studio/vitepress`: the header
and footer live in the fork (`VPLimoooNav.vue` / `VPLimoooFooter.vue`) and mirror the
main site's `base.html` / `_footer.html` — edit them there and the next deploy picks it
up (the fork is rebuilt only when its commit changes; use `LIMOOO_VITEPRESS_FETCH=0` to
build from a fork working tree). The site is a separate Cloudflare Pages project
(`limooo-docs`) so it never touches the main `limooo` artifact, and it shares the
`user_lang_preference` / `limooo_theme` cookies with the main site.

```bash
bash ops/docs_deploy.sh --build-only   # build + validate only
bash ops/docs_deploy.sh --dev          # local VitePress dev server
```

## Security design

- Session cookies use `Secure` + `HttpOnly` + `SameSite=Lax`, bound to `.limooo.cn`;
  every session has a random `sid` recorded in D1 `auth_sessions`, and `requireAuth`
  rejects revoked/expired sessions. Missing runtime HMAC keys or an unavailable
  `auth_sessions` table fail closed with 503.
- The gate fails closed too: with `TURNSTILE_SECRET`, `GATE_HMAC_KEY` or
  `SESSION_HMAC_KEY` empty, the edge answers 503 instead of rendering pages or
  issuing unsigned cookies.
- The `__gate` cookie is `<unix-expiry>.<HMAC-SHA256 hex>` (1h TTL, `HttpOnly`,
  `Domain=.limooo.cn`), minted and validated entirely at the edge.
- Identity comes from Cloudflare Access: the Worker self-verifies
  `Cf-Access-Jwt-Assertion` (RS256, JWKS cached 1h) and maps AUD → role, so Access is
  the only login surface.
- Keys and ciphertext stored separately, and never committed to the repository
- Blocking layers: the app-level D1 blocklist answers 403 at the edge, and
  `ops/sync-worker` keeps the Cloudflare IP List `limooo_blocklist` in step with the
  active rows for a WAF rule to consume (that custom rule is not deployed right now)
- Admin writes (create/update/delete) require the admin role; viewer is read-only
- Visitor IPs are never returned by list APIs; the full IP is Fernet-encrypted in
  `visitor_rollups.ip_enc` and decrypted one row at a time for admins

## Whitelist

Trusted sources are maintained in [`data/whitelist.txt`](data/whitelist.txt), one entry per line:

| Entry | Effect |
| --- | --- |
| `ASN/<number>` | Low-risk source (China Telecom / China Mobile / China Unicom, incl. Tietong and backbone AS9929). Intended to be served a Cloudflare Non-Interactive Challenge (`js_challenge`) instead of the Turnstile gate; that WAF rule is not deployed right now (see below). |
| `IP-CIDR/<ip>/<mask>` | Fully allowed source (e.g. `IP-CIDR/97.64.18.11/32`); skips both the blocklist and the challenge gate. |

The ASN list is sourced from [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn) (updated daily). The generated edge copy currently carries **320 low-risk ASNs** and **2 fully allowed IPs**. No WAF custom rule consumes these lists right now: the zone's `http_request_firewall_custom` phase is empty, and `ops/waf/rules.snapshot.json` mirrors the live phase as of its `captured_at` timestamp (0 rules at the last refresh) — rules deleted in the dashboard survive only in git history.

Per-runtime trust: edge code only treats `IP-CIDR` entries as trusted
(`isGateTrustedIp` → `functions/_data/gateTrust.ts`). After editing `data/whitelist.txt`,
regenerate the edge copy with a build (`bash ops/build.sh`, which runs
`ops/check_gate_trust.py --emit`).

## Source of truth

- User-facing strings: `locales/*.json`; `functions/_data/*` and API i18n routes are generated from it.
- Shared runtime constants: `config-contract.json` is the agreed cross-runtime contract; `src/config.py` and the generated `functions/_lib/config.ts` both consume it, with `ops/check_config_contract.py` enforcing agreement.
- Gate/redirect copy: `locales/*.json` via `functions/_data/runtime.ts`; `src/build.py` assembles it.
- D1 schema and migrations: `ops/migrations/*.sql`; `blocked_ips` is the sole authority for blocking.
- Security response headers baseline (when enabled): `ops/security-headers.json`.
- Deployment and runtime boundaries: `ops/deploy.sh`; Cloudflare Pages and Workers are the only runtimes.

## Cloudflare Pages runtime

The public site (home / services / contact, the gate, the visitor panel, the Apple Account manager, `images.limooo.cn` and the redirect relay) runs on Cloudflare Pages Functions, as do the status page and every scheduled job. DNS for the Pages hosts points at `limooo.pages.dev`.

Runtime split:

| Layer | Technology |
| --- | --- |
| Edge / human verification | Pages Functions (`functions/_middleware.ts`) |
| Pages | Pre-rendered static HTML at build time (multi-language) |
| Data | D1 (visitor analytics, blocklist, Apple Account management, auth sessions) |
| Human verification | Cloudflare Turnstile, gate page rendered in place |
| Independent Workers | `status.limooo.cn` (`limooo-status`: probes, status page, retention), `image.limooo.cn` (`image-watermark`), `limooo-blocklist-sync` |

### Build & directory layout

- `python3 src/build.py`: pre-renders the pages in 4 languages into `public/`, inlines
  `locales/*.json` as `functions/api/i18n/[lang].ts`, and generates shared
  `functions/_data/runtime.ts` (gate/redirect i18n + preload assets)
- `ops/migrations/001_init.sql`: D1 initial schema (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_d1.py`: generate D1 import SQL (output in `ops/out/`, git-ignored)
- `ops/migrations/007_visitor_status_indexes.sql`: adds `(status, ts)` and `(status, ip_hash, ts)` indexes for visitor status filtering
- `ops/sync-worker/`: a daily 03:30 Worker cron syncs active D1 `blocked_ips` rows to the Cloudflare IP List; `auto_block.py cf` is for explicit maintenance only

### Environment variables

Configured under **Pages project settings → Environment variables → Encrypt (Secret)**, not committed to the repo:

| Variable | Purpose |
| --- | --- |
| `TURNSTILE_SITEKEY` | Public sitekey of the Turnstile widget on the gate page |
| `TURNSTILE_SECRET` | Server-side siteverify secret |
| `GATE_HMAC_KEY` | HMAC-SHA256 signing key for the `__gate` cookie (`openssl rand -hex 32`) |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain; also the JWT `iss` used for verification |
| `ACCESS_ADMIN_AUDS` / `ACCESS_VIEWER_AUDS` | Comma-separated Access application AUD tags mapped to the admin / viewer role (admin wins) |
| `VISITOR_IP_KEY` | Fernet key for the encrypted full visitor IP column (`visitor_rollups.ip_enc`) |
| `OBSERVABILITY_HMAC_KEY` | HMAC key for the privacy-minimized visitor IP hash (`functions/_lib/tracking.ts`); the gate fails closed without it |
| `SESSION_HMAC_KEY` | Pages session-cookie signing key (separate from `GATE_HMAC_KEY`) |
| `APPLE_ACCOUNT_ENCRYPTION_KEY` | Fernet key (from `secrets/apple_account_encryption.key`) |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values (git-ignored). Configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for `ops/sync-worker` via `wrangler secret put`.

### Gate behavior

Every request is checked for the signed `__gate` cookie. Cloudflare `botManagement.verifiedBot` is accepted as a verified search-engine trust signal; arbitrary `Googlebot`/`GPTBot` User-Agent strings and client-supplied `cf_clearance` cookies do not bypass the gate. Low-risk China Telecom / Mobile / Unicom ASNs are listed for the WAF `js_challenge` tier (no such rule is deployed at the moment), while edge code trusts only the generated whitelist (`data/whitelist.txt` → `functions/_data/gateTrust.ts`) for a full bypass.

Unverified requests get the Turnstile gate page **in place**: the host and path never change. The middleware renders `public/<lang>/auth.html` at the requested URL with status `403`, and `POST /__gate/verify` answers on that same origin with `Set-Cookie: __gate=…` (1h, `Domain=.limooo.cn`), after which the page reloads the original target. `auth.limooo.cn` is the gate host: it serves the same page at its own root and owns the `/__gate/config|diag|verify` endpoints.

Every host that renders the gate is served by the same edge code, so there is no second gate implementation to keep in sync.

The middleware also enforces the normalized D1 blocklist and records privacy-minimized visitor analytics. The gate page is `no-store`/`noindex` and supports dark/light theme switching. The Turnstile widget must list every host that renders it (the `limooo.cn` gate subdomains, including `auth`, `status`, `visitor`, `apple` and `images`).

### Page serving (clean URLs, no language path prefix)

`src/build.py` pre-renders `public/<lang>/` in 4 languages; after the gate passes, the middleware picks a language by **cookie > Accept-Language > CF region > en-US** and fetches the matching page via `env.ASSETS.fetch()`, keeping the URL clean:

- `limooo.cn/` → home page; `limooo.cn/services` / `limooo.cn/contact` → corresponding pages
- `services.limooo.cn/` → services page; `contact.limooo.cn/` → contact page (subdomains serve content directly, no 301 to the main site)
- `visitor.limooo.cn/` → visitor panel (login required); `account.limooo.cn/apple` → Apple Account manager (login required)
- `images.limooo.cn/` → portfolio gallery plus the favicon/logo/QR asset host; `image.limooo.cn/portfolio/<img>` → watermarked variant from the normalization Worker (its root 301s to `images.limooo.cn`)
- `www.limooo.cn` → 301 to the main site
- Nav links keep absolute subdomain URLs (`https://services.limooo.cn` etc.); language switching is a pure frontend `applyLang()`, no reload, no URL change

### services.limooo.cn pricing (CSV-driven)

The services price list is **data, not markup**: `src/build.py` reads
`docs/services/*.csv` on every render (`src/services_pricing.py`) and fills the
plan grids in `src/templates/services.html`. Changing a price means editing the
CSV and deploying — no template edit.

| file | columns | fills |
| --- | --- | --- |
| `docs/services/convention.csv` | `shots,price[,bookable]` | 01 Convention, one card per shot-count tier |
| `docs/services/outdoor.csv` | `type,people,price[,bookable]` | 02 Outdoor, studio/outdoor × solo/duo |

Only the numbers, the tier set and the availability come from the CSV; labels,
unit suffixes and the notes block still come from `locales/*.json`
(`plan_studio_solo`, `unit_per_shot`, …).

**`bookable` (optional column)** drives both the struck-through price style and
the studio row in the notes block:

- per tier: `no` → that tier's price renders with
  `class="plan-price strikethrough"`; `yes`, an empty cell, or the whole column
  absent → normal price
- notes block: if **every** studio tier is `no`, the studio row shows the paused
  wording (`studio_paused`); as soon as one studio tier is bookable it shows
  `studio_bookable` instead

So "temporarily not booking" is data end to end: flip studio from `no` to `yes` in
`outdoor.csv` and the strikethrough *and* the paused note both disappear on the
next deploy, with no template or locale edit. The two can never disagree. Any
other value (e.g. `maybe`) fails the build rather than silently guessing.

**A `price` cell that is not a positive integer renders as `-`.** There is no
placeholder whitelist: empty, `N/A`, `TBD`, a typo (`1OO`), `0` and negative
numbers all mean "price not published". The card keeps the `CNY` prefix and the
unit suffix and only the number becomes `-` (`CNY - / shot`), so the layout stays
identical to the numeric tiers. `-` is not `0` and not "free"; mixing such cells
with numeric rows in one file is fine.

The rest of the contract is:

- convention rows come from the CSV in **ascending shot-count order**; the number
  of tiers is not fixed (adding a 12-shot row needs no code change)
- a convention tier gets a unit suffix only if it is listed in
  `CONVENTION_UNIT_KEYS`; unlisted tiers render the bare price
- outdoor rows must cover all four `type/people` combinations; they render in a
  fixed order (studio solo/duo, then outdoor solo/duo) regardless of row order

A missing file, wrong column, duplicate tier, unknown tier or unrecognized
`bookable` value **fails the build** — a wrong price list is worse than a failed
build. The price cell alone never fails the build: anything that is not a
positive integer renders as `-`.
`tests/test_services_pricing.py` covers all of these cases plus a round-trip
check against the committed CSVs.

`docs/services/` is excluded from the VitePress build (`srcExclude` in
`docs/.vitepress/config.mts`), so the CSVs stay a data source and are never
published to docs.limooo.cn.

### Performance / edge caching

- `public/_routes.json` excludes `/static/*` and root static assets from Pages
  Functions, so CSS/JS/fonts are served directly by the Pages asset server.
- `public/_headers` gives versioned static assets a long browser cache with
  `stale-while-revalidate`; `public/_routes.json` and `_headers` are both
  generated by `src/build.py`.
- Pre-rendered public HTML is reused through the in-process page cache
  (keyed by host + language), and responses advertise
  `public, max-age=300, stale-while-revalidate=3600` with
  `Vary: Accept-Language`. Edge caching is deliberately **not** claimed here:
  Cloudflare does not cache Pages Functions responses (`cf-cache-status` stays
  `DYNAMIC` on repeated requests), so a shared-cache lifetime directive would be
  dead configuration, and the language cookie stays out of `Vary` because it
  would only fragment the browser cache.
- First-party portfolio thumbnails and favicons use
  `images.limooo.cn/static/...` (static edge cache, bypasses Functions)
  instead of the watermark Worker; QR codes and externally hotlinked images
  still use `image.limooo.cn`.
- Portfolio originals are never published: `/static/portfolio/<img>` returns 404.
  Only clean thumbnails (`images.limooo.cn/static/portfolio/thumbs/<img>-<width>.{webp,avif}`)
  and the normalized, watermarked `/portfolio/<img>` on `image.limooo.cn` are public;
  originals stay in the git-ignored `src/static/portfolio/` and the private R2 bucket
  `limooo-originals` (`ops/upload_originals.sh`).
- Turnstile verification has a 3-second server-side timeout so Cloudflare
  challenge-platform incidents fail closed quickly instead of stalling users
  for up to 8 seconds.

### Production status

The shape of the live deployment, re-read any time with
`python3 ops/readme_facts.py --live`:

1. **Pages**: project `limooo` (`limooo.pages.dev`) serves `limooo.cn`, `www`, `services`, `contact`, `auth`, `visitor`, `account`, `images`, `image` and `redirect`; the docs site is the separate `limooo-docs` project behind `docs.limooo.cn`, and `fonts.limooo.cn` is backed by R2
2. **D1**: database `limooo` (APAC) is bound to the project as `DB`; the schema from `ops/migrations/` is present and `schema_version` tracks the applied versions; `apple_accounts` holds the Apple Account rows, and `blocked_ips` is the blocking authority (83 rows, 1 active — soft-deleted rows stay for audit)
3. **Secrets** live under **Pages → Settings → Environment variables → Encrypt**: the Turnstile pair, `GATE_HMAC_KEY`, `SESSION_HMAC_KEY`, `OBSERVABILITY_HMAC_KEY`, `VISITOR_IP_KEY`, `APPLE_ACCOUNT_ENCRYPTION_KEY` and the `ACCESS_*` bindings; `APPLEID_ENCRYPTION_KEY` and the two `AUTHENTIK_*` entries are leftovers that no runtime reads
4. **Access** fronts `visitor.limooo.cn`, `account.limooo.cn` and `admin.limooo.cn` as self-hosted applications; there is no self-hosted IdP and no custom login form
5. **Workers** run standalone: `limooo-status`, `limooo-blocklist-sync`, `limooo-d1-archive` and `image-watermark`; `status.limooo.cn` and `sink.limooo.cn` are Worker custom domains
6. **Cloudflare rules**: the custom-firewall phase is empty (the `limooo_blocklist` IP List is ready for a rule); the cache phase serves static assets, legacy image paths and watermark-Worker responses for a year while both HTML page-cache rules are disabled; the dynamic-redirect phase is empty, and `ops/waf/rules.snapshot.json` is a refresh-time mirror of that empty phase (removed rules live only in git history)
7. **Smoke checks**: `https://limooo.cn/_health` → 200, `https://limooo.cn/?challenge=1` → 403, `https://docs.limooo.cn/` and `https://status.limooo.cn/` → 200

The gate renders in place on every host, the real visitor IP is shown in the gate page
and logs, and Access remains the only identity source.

## License

[GNU AGPL v3.0](LICENSE.md)|[GNU AGPL v3.0 (Simplified Chinese)](LICENSE_zh_CN.md)|[GNU AGPL v3.0 (Japanese)](LICENSE_ja_JP.md)|[GNU AGPL v3.0 (Korean)](LICENSE_ko_KR.md)
