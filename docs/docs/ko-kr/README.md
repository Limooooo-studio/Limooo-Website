---
aside: false
title: 프로젝트 README
description: "Limooo 웹사이트 및 관리 시스템(Cloudflare 완전 서버리스 구성) 프로젝트 README"
---

# Limooo

[limooo.cn](https://limooo.cn)에서 운영되는 완전 서버리스(serverless) 개인 웹사이트 겸 관리 시스템입니다. 공개 페이지, 사람 확인 게이트, 방문자 패널, Apple Account 관리자, 모니터링, 상태 페이지가 모두 Cloudflare(Pages Functions, Workers, D1, R2)에서 실행됩니다.

## 기능

- **공개 페이지**: 홈, 서비스, 문의, 포트폴리오 — 4개 언어로 사전 렌더링되며 다크/라이트 테마 전환을 지원합니다
- **사람 확인**: Turnstile 게이트 페이지는 모든 호스트에서 요청된 URL에 **그 자리에서(in place)** 렌더링됩니다(도메인 간 이동 없음) — [게이트 동작](#게이트-동작) 참고
- **방문자 패널**(`visitor.limooo.cn`): Pages Function + D1 분석. 해시 처리된 방문자 식별자(목록 API에 원본 IP가 없음), 국가, 가능한 경우 ISP/ASN, 상태 코드 분포를 보여 주며 로그인으로 보호됩니다
- 최초 로드 후 방문자 상태 칩은 새 `/api/visitors` 요청 없이 로컬에서 필터링합니다. 딥 링크를 위해 API는 여전히 `?status=<3-digit>`을 받습니다.
- **Apple Account 관리자**(`account.limooo.cn/apple`): 드래그 앤 드롭 정렬을 지원하는 Pages Function + D1 CRUD. 비밀번호는 Fernet으로 암호화해 저장하고, 목록에는 마스킹된 비밀번호만 표시하며 임시로 평문을 공개할 수 있습니다
- **인증 및 역할**: Cloudflare Access가 유일한 신원 소스이며, Worker가 Access JWT를 자체 검증하고 AUD → admin(읽기·쓰기) / viewer(읽기 전용)로 매핑합니다
- **모니터링**: `limooo-status` Worker가 매분 HTTP/D1 대상을 프로브(probe)하고, 프로브가 다운된 동안에는 10초마다 다시 확인하며 결과를 D1에 저장합니다. 알림은 webhook으로 나가고 Email binding이 대체 수단입니다
- **상태 페이지**(`status.limooo.cn`): 같은 Worker가 D1에서 서버 렌더링하며, 일별 가동률은 `probe_uptime_daily` 롤업(rollup)에서 가져옵니다
- **자동 IP 차단**:
  - D1 `blocked_ips`가 권위 데이터이고, `sync-worker`가 활성 행을 Cloudflare IP List로 미러링해 엣지에서 차단합니다(원본 서버가 없으므로 ipset/iptables도 없음)
  - 대체 수단으로 애플리케이션 계층 전역 필터가 있으며, 차단된 IP는 곧바로 403을 받습니다
- **통합 리다이렉트 페이지**(`redirect.limooo.cn/?to=<https-url>`, `/r`도 허용): 모든 HTTPS 목적지로 리다이렉트하기 전에 중간 안내 페이지를 보여 줍니다
- **포트폴리오 이미지 처리**: 원본은 절대 공개하지 않으며, 워터마크가 들어간 전체 이미지(`image.limooo.cn/portfolio/*`)와 깨끗한 썸네일만 공개됩니다

## 기술 스택

| 계층 | 기술 | 실행 위치 |
| --- | --- | --- |
| 공개 페이지, 게이트, 방문자 패널, Apple Account 관리자, 상태 페이지 | Pages Functions (`functions/`) + 사전 렌더링된 정적 HTML | Cloudflare 엣지 |
| 데이터 | D1 (방문자 분석, 차단 목록, Apple Account 계정, 인증 세션, 프로브/하트비트) | Cloudflare |
| 사람 확인 | Cloudflare Turnstile, 게이트 페이지를 그 자리에서 렌더링 | Cloudflare + 브라우저 |
| 인증 | Cloudflare Access (Zero Trust JWT, Worker가 자체 검증) | Cloudflare |
| 모니터링 및 보존 | `ops/status-worker` (Cron Triggers + Durable Object 알람) | Cloudflare Workers |
| 차단 목록 동기화 | `ops/sync-worker` (일일 cron → Cloudflare IP List) | Cloudflare Workers |
| 이미지 워터마킹 | `ops/image-watermark` (경로 정규화 프록시) | Cloudflare Workers |
| 정적 자산 / 원본 백업 | Pages 자산 서버 + 비공개 R2 버킷 `limooo-originals` | Cloudflare |
| 배포 | `ops/deploy.sh` (git + `ops/pages_deploy.sh` + `ops/workers_deploy.sh`) | 로컬 |

## 프로젝트 구조

```
├── src/
│   ├── config.py          # unified config: paths, languages, domains, DB/IP utils (consumes config-contract.json)
│   ├── auto_block.py      # legacy log scan + blocklist → D1 sync (no origin host to scan any more; kept for reference)
│   ├── render_app.py      # build-time read-only renderer used by src/build.py
│   ├── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # auditable snapshot of D1 blocked_ips (D1 is the sole authority)
│   ├── whitelist.txt      # trusted ASNs (low-risk) + fully allowed IPs/CIDRs
│   └── gate_trust.json    # generated gate trust config
├── secrets/               # secrets & certificates, git-ignored
│   ├── webauthn.env       # env file read by the deploy scripts
│   └── apple_account_encryption.key     # Apple Account password encryption key
├── ops/                   # deployment & ops tooling
│   ├── deploy.sh          # the single deploy entry point (commit/push + Pages + docs + Worker)
│   ├── build.sh           # Pages build: venv, contract checks, public/manifest.json
│   ├── pages_deploy.sh    # Cloudflare Pages build + Wrangler deploy
│   ├── docs_deploy.sh     # docs.limooo.cn build + deploy (VitePress → Pages project limooo-docs)
│   ├── docs_headers.py    # generates the docs site `_headers` (CSP hashes + cache)
│   ├── ci_check.sh        # local replica of .github/workflows/tests.yml
│   ├── security-headers.json      # single source of the response-header baseline
│   ├── check_config_contract.py / check_gate_trust.py / check_security_headers.py
│   ├── migrations/        # D1 schema migrations
│   ├── export_d1.py       # unified D1 import SQL/JSON export (apple-account | blocklist)
│   ├── prune_d1.py        # legacy D1 retention script (live retention now runs in status-worker)
│   ├── upload_originals.sh        # private R2 backup of portfolio originals
│   ├── status-worker/     # Worker: probes, status page, alerting, D1 retention
│   ├── image-watermark/   # Worker: image.limooo.cn watermark normalizer
│   ├── d1-archive/        # D1 snapshot/archive Worker
│   ├── sync-worker/       # Worker: D1 blocked_ips → Cloudflare IP List (cron 03:30)
│   └── requirements.txt   # Python dependencies
├── functions/             # Cloudflare Pages Functions
│   ├── _middleware.ts     # gate/redirect/blocklist/visitors/ray orchestration
│   ├── _lib/              # config, d1, cidr, gate, access, session, fernet, routing
│   ├── _data/             # generated i18n/runtime modules (do not hand-edit)
│   ├── api/               # apple-account, auth, i18n, ray, visitors endpoints
│   ├── __gate/            # Turnstile verify entry point (/__gate/verify)
│   └── login.ts / logout.ts
├── locales/               # i18n / translation catalogs
├── public/                # Pages build output (git keeps only .gitkeep)
├── preview/               # local preview (build-generated; git keeps only .gitkeep)
└── docs/                  # docs.limooo.cn VitePress root + services.limooo.cn price-list CSVs
```

## 빠른 시작

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Build the static site locally
python3 src/build.py
```

깔끔한 VS Code 환경을 위해서는 `.vscode/extensions.json`에 나열된 권장 확장(Jinja, Pylance)을
설치하세요. 워크스페이스 설정이 Jinja 템플릿을 연결해 주므로 HTML/CSS/JS 진단이
템플릿 문법을 잘못 해석하지 않습니다.

생성된 사이트를 로컬에서 미리 보려면 빌드한 뒤 `preview/`의 결과물을 여세요.

## 빌드, 테스트 및 배포

깨끗한 로컬 빌드를 위해서는 배포 스크립트와 동일한 의존성 세트를 사용하세요:

```bash
cd Flask
npm ci
npm run build
```

`src/build.py`는 `public/<lang>/*.html`, `public/static/`,
`functions/_data/i18n.ts`, `functions/_data/runtime.ts`와 `preview/`를 다시 생성합니다.
이 결과물을 직접 수정하지 말고, `locales/*.json`이나 템플릿, 정적 소스를 바꾼 뒤
다시 빌드하세요. `src/static/tailwind.css`는 저장소에 커밋된 Tailwind 사전 빌드
결과물입니다. `npm run build`는 `ops/build.sh`를 사용하며, 이 스크립트가 `.venv-build`를
만들고 `public/manifest.json`(빌드 산출물 해시 증거)을 생성합니다.

Pages 결과물만 배포하려면:

```bash
# build + validate only, no Cloudflare writes
bash ops/pages_deploy.sh --build-only

# build + validate + deploy Pages + smoke test (/_health must be 200)
bash ops/pages_deploy.sh

# full deploy: (1) commit (2) push (3) deploy Pages + docs
bash ops/deploy.sh --all
```

**제로 VPS 스크립트(2026-09-17 재작성)**: `ops/deploy.sh`가 유일한 배포 진입점이며
(예전 `ops/upload.sh` 포워더는 여기로 흡수했습니다 — 스크립트가 하나뿐이라 서로
어긋날 병렬 사본이 없습니다), `ops/pages_deploy.sh`가 빌드 + Pages를 담당합니다.
`--dry-run`은 어떤 원격에도 쓰지 않고 계획만 출력합니다.

기본적으로 `deploy.sh`는 **조용합니다**: 단계마다 상태 한 줄만 출력하고, 해당 단계가
실패했을 때만 전체 로그를 덤프합니다. 모든 것을 스트리밍하려면 `--full`을 추가하세요
(빌드 매니페스트, 산출물 개수, wrangler 업로드 진행률). 플래그와 단계는 어느 쪽이든
동일하며, `--full`은 출력의 상세도만 바꿉니다.

자격 증명은 로컬 `secrets/webauthn.env`에서 읽으며(절대 커밋하지 않고, 절대
출력하지 않음), ssh / rsync / 원격 systemd 단계는 없습니다.
`ops/migrate_d1.sh`와 `ops/workers_deploy.sh`도 `--dry-run`을 지원합니다.

자동화된 테스트 진입점이 마련되어 있습니다:

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## 환경 변수

배포 스크립트가 `secrets/webauthn.env`에서 읽으며 Git에 커밋되지 않습니다. Pages 런타임은 자체 시크릿 세트를 사용합니다(아래 엣지 섹션 참고).

| 변수 | 설명 |
| --- | --- |
| `GATE_HMAC_KEY` | `__gate` 쿠키용 HMAC-SHA256 키로, 엣지에서 발급하고 검증합니다 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | `ops/d1_client.py`, `ops/pages_deploy.sh`, `ops/workers_deploy.sh`를 위한 Cloudflare API 접근 |

키 자료는 저장소 밖에 있습니다. `apple_account_encryption.key`는 Apple Account 비밀번호와
암호화된 방문자 IP 컬럼에 사용하는 Fernet 키입니다.

## Cron 작업

더 이상 VPS crontab은 없습니다(2026-09-17 폐기). 모든 스케줄링은 이제
Cloudflare에서, 각 Worker의 `wrangler.toml`에 선언된 Worker Cron Triggers로
동작합니다:

| 스케줄 | Worker | 작업 |
| --- | --- | --- |
| `* * * * *` | `ops/status-worker` | 매분 HTTP/D1 프로브; 프로브가 다운된 동안 Durable Object 알람이 10초마다 다시 확인하고 상태가 바뀌면 알립니다 |
| `47 3 * * *` | `ops/status-worker` | D1 보존(`src/retention.ts`): `ray_log_v2`(7일), `visitors_v2` / `visitor_rollups`(30일), `events` / `heartbeats` / `probe_uptime_daily`(90일) 정리 |
| `30 3 * * *` | `ops/sync-worker` | 활성 D1 `blocked_ips` 행을 Cloudflare IP List로 미러링 |

TLS 인증서는 Pages 사용자 지정 도메인에 대해 Cloudflare가 발급하고 갱신하므로
`acme.sh`도 사라졌습니다. `ops/migrate_d1.sh`와 `ops/workers_deploy.sh`는 수동 실행하는
`--dry-run` 지원 유지보수 진입점입니다.

## 배포

배포할 서버가 없습니다. 대상은 Cloudflare Pages(`limooo`)와 독립 Worker들입니다.
저장소 루트에서:

```bash
cd Flask
bash ops/deploy.sh              # with no arguments = --all (full deploy, see below)
bash ops/deploy.sh --all        # commit + push + deploy Pages + docs
bash ops/deploy.sh --pages      # deploy the main Pages project only
bash ops/deploy.sh --docs       # deploy docs.limooo.cn only
bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker
bash ops/deploy.sh --all --full             # same, but stream every step's output
```

`ops/deploy.sh`를 **인수 없이 실행하는 것은 정확히 `--all`**입니다: commit + push +
Pages + docs, 즉 "전체 배포" 계약입니다. 로컬에 이미 커밋된 것만 배포하려면
`--pages` / `--docs`를 명시적으로 넘기세요.

출력은 기본적으로 조용합니다(단계마다 상태 한 줄). 전체 과정을 지켜보려면 `--full`을
추가하세요. `--dry-run`은 위 플래그의 어떤 조합과도 함께 쓸 수 있습니다.

자격 증명은 로컬 `secrets/webauthn.env`에서 읽으며, ssh, rsync, systemd, Nginx 단계는
없습니다.

### 문서 사이트(docs.limooo.cn)

`Flask/docs/`는 **서브도메인별 컨테이너**입니다: `docs/`에는 docs.limooo.cn
VitePress 루트(언어별·페이지별 마크다운 파일 하나)가, `services/`에는
services.limooo.cn 가격표 CSV가 들어 있습니다. 언어 코드는 URL의 **마지막** 세그먼트이고,
콘텐츠 페이지는 항상 명시적으로 붙입니다(`/README/zh-cn`, `/README/en-us`). 접미사 없는
`/README`는 `/README/zh-cn`으로 302되며, 홈 `/`만 예외입니다.

`.vitepress/rewrites.json`(콘텐츠 옆에 있음)이 소스들을 접미사가 붙은 라우트로
매핑하고, `.vitepress/config.mts`가 `additionalConfig`를 통해 각 페이지에 고유한
`lang` / `themeConfig`를 부여합니다. 페이지를 추가하려면 각 언어 디렉터리에 마크다운 파일을 넣고 rewrites 항목과
`public/_redirects`의 접미사 없는 경로용 302 한 줄을 더하면 됩니다 — 마크다운 파일에
대응하는 HTML이 없으면 `ops/docs_check_output.py`가 빌드를 실패시킵니다.

이 사이트는 포크 `Limooooo-Studio/vitepress`의 VitePress로 빌드합니다: 헤더와
푸터는 포크(`VPLimoooNav.vue` / `VPLimoooFooter.vue`)에 있고 메인 사이트의
`base.html` / `_footer.html`을 그대로 반영합니다 — 포크에서 고치면 다음 배포에서
반영됩니다(포크는 커밋이 바뀔 때만 다시 빌드하며, 포크 작업 트리에서 빌드하려면
`LIMOOO_VITEPRESS_FETCH=0`을 사용하세요). 이 사이트는 별도의 Cloudflare Pages
프로젝트(`limooo-docs`)이므로 메인 `limooo` 산출물을 절대 건드리지 않으며, 메인
사이트와 `user_lang_preference` / `limooo_theme` 쿠키를 공유합니다.

```bash
bash ops/docs_deploy.sh --build-only   # build + validate only
bash ops/docs_deploy.sh --dev          # local VitePress dev server
```

## 보안 설계

- 세션 쿠키는 `Secure` + `HttpOnly` + `SameSite=Lax`를 사용하고 `.limooo.cn`에
  바인딩됩니다. 모든 세션은 D1 `auth_sessions`에 기록된 무작위 `sid`를 가지며,
  `requireAuth`는 폐기되거나 만료된 세션을 거부합니다. 런타임 HMAC 키가 없거나
  `auth_sessions` 테이블을 사용할 수 없으면 503으로 fail closed 합니다.
- 게이트도 fail closed입니다: `TURNSTILE_SECRET`, `GATE_HMAC_KEY`,
  `SESSION_HMAC_KEY`가 비어 있으면 엣지는 페이지를 렌더링하거나 서명 없는 쿠키를
  발급하는 대신 503을 응답합니다.
- `__gate` 쿠키는 `<unix-expiry>.<HMAC-SHA256 hex>`(TTL 1시간, `HttpOnly`,
  `Domain=.limooo.cn`)이며 전적으로 엣지에서 발급하고 검증합니다.
- 신원은 Cloudflare Access에서 옵니다: Worker가
  `Cf-Access-Jwt-Assertion`을 자체 검증하고(RS256, JWKS 1시간 캐시) AUD → 역할로
  매핑합니다. 자체 호스팅 IdP도, 사용자 지정 로그인 폼도 없습니다.
- 키와 암호문은 분리해 보관하며 저장소에 절대 커밋하지 않습니다
- 차단 계층: 애플리케이션 계층 403/Worker → 엣지의 Cloudflare WAF + IP List
- 관리자 쓰기(생성/수정/삭제)에는 admin 역할이 필요하며, viewer는 읽기 전용입니다
- 방문자 IP는 목록 API에서 절대 반환하지 않습니다. 전체 IP는
  `visitor_rollups.ip_enc`에 Fernet으로 암호화하고 관리자에게 한 행씩 복호화합니다

## 화이트리스트

신뢰 소스는 [`data/whitelist.txt`](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/data/whitelist.txt)에서 한 줄에 하나씩 관리합니다:

| 항목 | 효과 |
| --- | --- |
| `ASN/<number>` | 저위험 소스(중국 통신사 China Telecom / China Mobile / China Unicom, Tietong과 백본 AS9929 포함). Turnstile 게이트 대신 Cloudflare Non-Interactive Challenge(`js_challenge`)를 받습니다. |
| `IP-CIDR/<ip>/<mask>` | 완전 허용 소스(예: `IP-CIDR/97.64.18.11/32`)로, 차단 목록과 챌린지 게이트를 모두 건너뜁니다. |

ASN 목록은 [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn)(매일 갱신)에서 가져오며 WAF 저위험 `js_challenge` 규칙으로 미러링됩니다. 허용 IP는 `ops/check_gate_trust.py`를 통해 `functions/_data/gateTrust.ts`로, 그리고 Cloudflare WAF skip 규칙으로 미러링됩니다.

런타임별 신뢰: 엣지 코드는 `IP-CIDR` 항목만 신뢰합니다
(`isGateTrustedIp` → `functions/_data/gateTrust.ts`). `ASN/` 줄은
Cloudflare WAF `js_challenge` 규칙으로 미러링됩니다. `data/whitelist.txt`를 수정한
뒤에는 빌드로 엣지 사본을 다시 생성하세요(`bash ops/build.sh`, 이 스크립트가
`ops/check_gate_trust.py --emit`을 실행합니다).

## 신뢰의 원천(source of truth)

- 사용자 노출 문자열: `locales/*.json`; `functions/_data/*`와 API i18n 라우트는 여기서 생성됩니다.
- 공유 런타임 상수: `config-contract.json`은 런타임 간에 합의된 계약이며, `src/config.py`와 생성된 `functions/_lib/config.ts`가 이를 함께 사용하고 `ops/check_config_contract.py`가 일치를 강제합니다.
- 게이트/리다이렉트 문구: `functions/_data/runtime.ts`를 통한 `locales/*.json`이며, `src/build.py`가 이를 조립합니다.
- D1 스키마와 마이그레이션: `ops/migrations/*.sql`; 차단에 관한 한 `blocked_ips`가 유일한 권위입니다.
- 보안 응답 헤더 기준선(활성화된 경우): `ops/security-headers.json`.
- 배포 및 런타임 경계: `ops/deploy.sh`. 런타임은 Cloudflare Pages와 Workers뿐입니다.

## Cloudflare Pages 런타임

공개 사이트(홈 / 서비스 / 문의, 게이트, 방문자 패널, Apple Account 관리자, `images.limooo.cn`와 리다이렉트 릴레이)는 Cloudflare Pages Functions에서 실행되며, 상태 페이지와 모든 예약 작업도 마찬가지입니다. Pages 호스트의 DNS는 `limooo.pages.dev`를 가리킵니다.

런타임 구성:

| 계층 | 기술 |
| --- | --- |
| 엣지 / 사람 확인 | Pages Functions (`functions/_middleware.ts`) |
| Pages | 빌드 시 사전 렌더링된 정적 HTML (다국어) |
| 데이터 | D1 (방문자 분석, 차단 목록, Apple Account 관리, 인증 세션) |
| 사람 확인 | Cloudflare Turnstile, 게이트 페이지를 그 자리에서 렌더링 |
| 독립 Worker | `status.limooo.cn` (`limooo-status`: 프로브, 상태 페이지, 보존), `image.limooo.cn` (`image-watermark`), `limooo-blocklist-sync` |

### 빌드 및 디렉터리 구조

- `python3 src/build.py`: 4개 언어 페이지를 `public/`으로 사전 렌더링하고,
  `locales/*.json`을 `functions/api/i18n/[lang].ts`로 인라인하며, 공유
  `functions/_data/runtime.ts`(게이트/리다이렉트 i18n + 프리로드 자산)를 생성합니다
- `ops/migrations/001_init.sql`: D1 초기 스키마 (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_d1.py`: D1 가져오기용 SQL 생성 (출력은 `ops/out/`, git 제외)
- `ops/migrations/007_visitor_status_indexes.sql`: 방문자 상태 필터링을 위한 `(status, ts)`와 `(status, ip_hash, ts)` 인덱스를 추가합니다
- `ops/sync-worker/`: 매일 03:30 Worker cron이 활성 D1 `blocked_ips` 행을 Cloudflare IP List로 동기화합니다. `auto_block.py cf`는 명시적인 유지보수 용도로만 씁니다
- 참고: Pages는 `POST /logout/backchannel`을 노출하고 `sub`로 D1 `auth_sessions`를
  폐기합니다. 레거시 Flask `/logout/backchannel`은 더 이상 배포되지 않습니다.

### 환경 변수

저장소에 커밋하지 않고 **Pages 프로젝트 설정 → 환경 변수 → Encrypt (Secret)** 아래에 구성합니다:

| 변수 | 용도 |
| --- | --- |
| `TURNSTILE_SITEKEY` | 게이트 페이지의 Turnstile 위젯 공개 sitekey |
| `TURNSTILE_SECRET` | 서버 측 siteverify 시크릿 |
| `GATE_HMAC_KEY` | `__gate` 쿠키용 HMAC-SHA256 서명 키 (`openssl rand -hex 32`) |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access 팀 도메인이며, 검증에 쓰는 JWT `iss`이기도 합니다 |
| `ACCESS_ADMIN_AUDS` / `ACCESS_VIEWER_AUDS` | admin / viewer 역할에 매핑되는 쉼표 구분 Access 애플리케이션 AUD 태그 (admin 우선) |
| `VISITOR_IP_KEY` | 암호화된 방문자 전체 IP 컬럼(`visitor_rollups.ip_enc`)용 Fernet 키 |
| `SESSION_HMAC_KEY` | Pages 세션 쿠키 서명 키 (`GATE_HMAC_KEY`와 별개) |
| `APPLE_ACCOUNT_ENCRYPTION_KEY` | Fernet 키 (`secrets/apple_account_encryption.key`에서 가져옴) |

로컬 개발: `.dev.vars.example`을 `.dev.vars`로 복사하고 실제 값을 채우세요(git 제외). `ops/sync-worker`용 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`는 `wrangler secret put`으로 구성하세요.

### 게이트 동작

모든 요청은 서명된 `__gate` 쿠키를 검사합니다. Cloudflare `botManagement.verifiedBot`은 검증된 검색 엔진 신뢰 신호로 인정합니다. 임의의 `Googlebot`/`GPTBot` User-Agent 문자열과 클라이언트가 제공한 `cf_clearance` 쿠키는 게이트를 우회하지 못합니다. 저위험 China Telecom / Mobile / Unicom ASN은 Cloudflare WAF `js_challenge` 계층이 처리하고, 엣지 코드는 완전 우회를 위해 생성된 화이트리스트(`data/whitelist.txt` → `functions/_data/gateTrust.ts`)만 신뢰합니다.

검증되지 않은 요청은 Turnstile 게이트 페이지를 **그 자리에서** 받습니다: 호스트와 경로는 절대 바뀌지 않습니다. 미들웨어(middleware)는 요청된 URL에 `public/<lang>/auth.html`을 상태 `403`으로 렌더링하고, `POST /__gate/verify`가 같은 오리진에서 `Set-Cookie: __gate=…`(1시간, `Domain=.limooo.cn`)와 함께 응답하면 페이지가 원래 목적지로 다시 로드합니다. `auth.limooo.cn`은 게이트 호스트로, 자체 루트에서 같은 페이지를 제공하며(404도, 메인 사이트로의 리다이렉트도 없음) `/__gate/config|diag|verify` 엔드포인트를 소유합니다 — 다만 더 이상 리다이렉트 대상은 아닙니다.

게이트를 렌더링하는 모든 호스트는 동일한 엣지 코드가 처리하므로, 동기화해야 할 두 번째 게이트 구현이 없습니다.

미들웨어는 정규화된 D1 차단 목록도 강제하고 프라이버시를 최소화한 방문자 분석을 기록합니다. 게이트 페이지는 `no-store`/`noindex`이며 다크/라이트 테마 전환을 지원합니다. Turnstile 위젯에는 이를 렌더링하는 모든 호스트(`auth`, `status`, `visitor`, `apple`, `images`를 포함한 `limooo.cn` 게이트 서브도메인)를 등록해야 합니다.

### 페이지 제공(clean URL, 언어 경로 접두사 없음)

`src/build.py`가 4개 언어로 `public/<lang>/`을 사전 렌더링합니다. 게이트를 통과하면 미들웨어가 **cookie > Accept-Language > CF region > en-US** 순으로 언어를 고르고 `env.ASSETS.fetch()`로 해당 페이지를 가져와 URL을 깔끔하게 유지합니다:

- `limooo.cn/` → 홈 페이지; `limooo.cn/services` / `limooo.cn/contact` → 각각 해당 페이지
- `services.limooo.cn/` → 서비스 페이지; `contact.limooo.cn/` → 문의 페이지(서브도메인이 콘텐츠를 직접 제공하며 메인 사이트로 301하지 않음)
- `visitor.limooo.cn/` → 방문자 패널(로그인 필요); `account.limooo.cn/apple` → Apple Account 관리자(로그인 필요)
- `images.limooo.cn/` → 포트폴리오 갤러리 겸 favicon/logo/QR 자산 호스트; `image.limooo.cn/portfolio/<img>` → 정규화 Worker가 만든 워터마크 버전(이 호스트의 루트는 `images.limooo.cn`으로 301)
- `www.limooo.cn` → 메인 사이트로 301
- 내비게이션 링크는 절대 서브도메인 URL(`https://services.limooo.cn` 등)을 유지합니다. 언어 전환은 순수 프런트엔드 `applyLang()`이며 새로고침도, URL 변경도 없습니다

### services.limooo.cn 가격(CSV 기반)

서비스 가격표는 **마크업이 아니라 데이터**입니다: `src/build.py`가 렌더링할 때마다 `docs/services/*.csv`를 읽어(`src/services_pricing.py`) `src/templates/services.html`의 플랜 그리드를 채웁니다. 가격을 바꾸려면 CSV를 수정하고 배포하면 되며, 템플릿은 고칠 필요가 없습니다.

| 파일 | 컬럼 | 채우는 곳 |
| --- | --- | --- |
| `docs/services/convention.csv` | `张数,价格[,是否接单]` | 01 Convention, 촬영 장수 티어마다 카드 하나 |
| `docs/services/outdoor.csv` | `类型,人数,价格[,是否接单]` | 02 Outdoor, 스튜디오/야외 × 1인/2인 |

숫자, 티어 구성, 예약 가능 여부만 CSV에서 오고, 레이블·단위 접미사·설명 블록은 여전히 `locales/*.json`에서 옵니다
(`plan_studio_solo`, `unit_per_shot`, …).

**`是否接单`(선택 컬럼)** 은 취소선 가격 스타일과 설명 블록의 스튜디오 행을 모두 제어합니다:

- 티어별: `否` → 해당 티어 가격이
  `class="plan-price strikethrough"`로 렌더링됩니다. `是`, 빈 셀, 또는 컬럼 자체가
  없는 경우 → 일반 가격
- 설명 블록: **모든** 棚拍(스튜디오 촬영) 티어가 `否`이면 스튜디오 행에 예약 중단
  문구(`studio_paused`)가 표시되고, 스튜디오 티어 하나라도 예약 가능해지면 곧바로
  `studio_bookable`이 대신 표시됩니다

따라서 "일시적으로 예약을 받지 않음"은 처음부터 끝까지 데이터입니다: `outdoor.csv`에서 棚拍을 `否`에서 `是`로 바꾸면 다음 배포에서 취소선과 예약 중단 안내가 *둘 다* 사라지며, 템플릿이나 로케일을 고칠 필요가 없습니다. 둘은 결코 어긋날 수 없습니다. 다른 값(예: `maybe`)은 조용히 추측하지 않고 빌드를 실패시킵니다.

**`价格`가 양의 정수가 아니면 `-`로 렌더링됩니다.** 자리 표시자 허용 목록은 없습니다.
빈 칸, `N/A`, `待定`, 잘못 입력한 숫자(`1OO`), `0`, 음수는 모두 "가격 미공개"를
뜻합니다. 카드는 `CNY` 접두사와 단위 접미사를 유지한 채 숫자만 `-`가 되어
(`CNY - / 张`), 레이아웃이 숫자 티어와 똑같이 유지됩니다. `-`는 `0`도 "무료"도
아니며, 한 파일에 이런 셀과 숫자 행을 섞어도 됩니다.

나머지 계약은 다음과 같습니다:

- convention 행은 CSV에서 **촬영 장수 오름차순**으로 옵니다. 티어 수는
  고정이 아닙니다(12장 행을 추가해도 코드 변경이 필요 없음)
- convention 티어는 `CONVENTION_UNIT_KEYS`에 등록된 경우에만 단위 접미사를
  받습니다. 등록되지 않은 티어는 숫자만 렌더링합니다
- outdoor 행은 네 가지 `类型/人数` 조합을 모두 포함해야 하며, 행 순서와 무관하게
  고정된 순서(스튜디오 1인/2인, 그다음 야외 1인/2인)로 렌더링됩니다

파일 누락, 잘못된 컬럼, 중복 티어, 알 수 없는 티어, 인식할 수 없는 `是否接单` 값은
**빌드를 실패**시킵니다 — 잘못된 가격표는 빌드 실패보다 나쁩니다. 가격 셀만은
빌드를 실패시키지 않습니다: 양의 정수로 해석되지 않는 내용은 모두 `-`로
렌더링됩니다. `tests/test_services_pricing.py`가 이런 모든 경우와
커밋된 CSV에 대한 왕복(round-trip) 검사까지 커버합니다.

`docs/services/`는 VitePress 빌드에서 제외되므로(`docs/.vitepress/config.mts`의
`srcExclude`) CSV는 데이터 소스로 남고 docs.limooo.cn에 절대 게시되지 않습니다.

### 성능 / 엣지 캐싱

- `public/_routes.json`은 `/static/*`과 루트 정적 자산을 Pages
  Functions에서 제외하므로 CSS/JS/폰트는 Pages 자산 서버가 직접 제공합니다.
- `public/_headers`는 버전이 지정된 정적 자산에
  `stale-while-revalidate`와 함께 긴 브라우저 캐시를 부여합니다.
  `public/_routes.json`과 `_headers`는 모두 `src/build.py`가 생성합니다.
- 검증된 공개 HTML은 언어별로 Pages Cache API에 300초 동안 캐시되며,
  응답은 `public, s-maxage=300`과 `Vary: Accept-Language`를 알립니다.
- 자사 포트폴리오 썸네일과 favicon은 워터마크 Worker 대신
  `images.limooo.cn/static/...`(정적 엣지 캐시, Functions 우회)을
  사용합니다. QR 코드와 외부에서 핫링크한 이미지는 여전히 `image.limooo.cn`을
  사용합니다.
- 포트폴리오 원본은 절대 공개하지 않습니다: `/static/portfolio/<img>`는 404를 반환합니다.
  깨끗한 썸네일(`images.limooo.cn/static/portfolio/thumbs/<img>-<width>.{webp,avif}`)과
  `image.limooo.cn`의 정규화·워터마크된 `/portfolio/<img>`만 공개되며,
  원본은 git에서 제외된 `src/static/portfolio/`와 비공개 R2 버킷
  `limooo-originals`(`ops/upload_originals.sh`)에 남습니다.
- Turnstile 검증에는 3초의 서버 측 타임아웃이 있어, Cloudflare
  챌린지 플랫폼 장애 시 사용자를 최대 8초까지 붙잡아 두는 대신 빠르게
  fail closed 합니다.

### 프로덕션 상태

다음은 모두 실제로 운영 중입니다:

1. Pages 프로젝트(`limooo`, `limooo.pages.dev`)와 D1 데이터베이스(`limooo`, APAC)를 생성했고, D1 바인딩 `DB`를 프로젝트에 연결했습니다
2. 마이그레이션 `001`–`015`를 적용했고 `ops/out/apple-account.sql`(5행)을 가져왔습니다. 1255행짜리 `blocklist.sql` 스냅샷도 존재하지만 사용자가 복원하지 않기로 했으므로 프로덕션 `blocked_ips`는 0으로 유지되고 새로운 증거로만 다시 쌓입니다
3. **Pages → Settings → Environment variables → Encrypt** 아래에 시크릿을 구성했습니다: `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`(Turnstile 위젯은 Managed 모드이고, 도메인 목록은 이를 렌더링하는 모든 호스트 — `auth`, `status`, `visitor`, `account`, `images`를 포함한 `limooo.cn` 게이트 서브도메인 — 를 포함), `GATE_HMAC_KEY` / `SESSION_HMAC_KEY`, `ACCESS_*` AUD 매핑, `APPLE_ACCOUNT_ENCRYPTION_KEY`, `VISITOR_IP_KEY`
4. Pages에 배포하고 실제 운영에서 확인했습니다: 루트 경로 403 게이트 페이지 + `Cache-Control: no-store`, 로고 200, 실패 시 `/__gate/verify` 재렌더링, Location/IP/Ray ID 진단 정상. 위조된 쿠키는 거부됩니다
5. WAF 사용자 지정 규칙 운영 중: `ip.src in $limooo_blocklist` → block
6. **DNS**: `limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `account` / `images` / `redirect` → CNAME `limooo.pages.dev`(프록시됨), 모든 사용자 지정 도메인 활성. `status.limooo.cn`은 `limooo-status` Worker이고 `image.limooo.cn`은 워터마크 Worker이며, `images.limooo.cn`은 정적 자산 호스트입니다. 자사 페이지는 `/static/...` 경로(`https://images.limooo.cn/static/portfolio/thumbs/IMG_0203-800.webp`)를 참조합니다
7. 게이트는 `auth.limooo.cn`에 있고 그 자리에서 렌더링됩니다: 서브도메인은 `/zh-CN/` 언어 접두사 없이 콘텐츠를 직접 제공하며, 검증되지 않은 요청은 원래 호스트와 경로를 유지합니다
8. **visitor / apple / redirect는 Pages에서 실행됩니다**: 방문자 패널(분석)과 Apple Account 관리자는 메인 사이트와 동일한 Pages Functions(로그인 / API / D1)를 공유합니다. `redirect.limooo.cn`은 **사람 확인이 면제되는** 순수 릴레이 페이지입니다(검증 후 리다이렉트 루프를 피하기 위함)
9. **남은 서버가 없습니다**: authentik, Uptime Kuma, nginx, Flask 런타임은 2026-09-17에 VPS와 함께 폐기했습니다. 프로브, 상태 페이지, 알림, D1 보존은 `ops/status-worker`가 담당합니다

프로덕션 상태(2026-09-26):

- 프로덕션 D1에 마이그레이션이 적용되어 있음을 확인했습니다. `007` 인덱스, `011` 읽기 절감 롤업, `014` 방문자 IP 암호화를 포함합니다.
- Access가 유일한 신원 소스이며, 자체 호스팅 IdP도 사용자 지정 로그인 페이지도 없습니다.
- 게이트는 모든 호스트에서 그 자리에서 렌더링되며, 게이트 페이지/로그에는 실제 방문자 IP가 표시됩니다.
- 과거의 1255개 항목 차단 목록은 복원하지 **않습니다**. 백업은 아카이브로만 남습니다.

## 라이선스

[GNU AGPL v3.0](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE.md)|[GNU AGPL v3.0-중국어 간체](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_zh_CN.md)|[GNU AGPL v3.0-일본어](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ja_JP.md)|[GNU AGPL v3.0-한국어](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ko_KR.md)
