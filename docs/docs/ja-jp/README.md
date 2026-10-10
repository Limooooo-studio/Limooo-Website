---
aside: false
title: プロジェクト README
description: "Limooo のウェブサイトと管理システム（Cloudflare 完全サーバーレス構成）のプロジェクト README"
---

# Limooo

[limooo.cn](https://limooo.cn) で稼働する、完全サーバーレスの個人ウェブサイト兼管理システムです。公開ページ、人間検証ゲート、ビジターパネル、Apple Account マネージャー、監視、ステータスページは、すべて Cloudflare（Pages Functions、Workers、D1、R2）上で動作します。

## 機能

- **公開ページ**：ホーム、サービス、お問い合わせ、ポートフォリオ — 4 言語で事前レンダリングされ、ダーク／ライトテーマの切り替えに対応
- **人間検証（human verification）**：Turnstile ゲートページは、どのホストでも要求された URL に**その場で**レンダリングされます（クロスドメインへの遷移なし）— [ゲートの挙動](#ゲートの挙動)を参照
- **ビジターパネル（visitor panel）**（`visitor.limooo.cn`）：Pages Function + D1 によるアクセス解析。ハッシュ化された訪問者識別子（一覧系 API は生の IP を返しません）、国、取得できる場合は ISP/ASN、ステータスコードの分布を表示し、ログインで保護されています
- 初回読み込み後は、訪問者ステータスのチップが新たな `/api/visitors` リクエストなしにローカルで絞り込まれます。API はディープリンク用に `?status=<3-digit>` も引き続き受け付けます。
- **Apple Account マネージャー**（`account.limooo.cn/apple`）：Pages Function + D1 による CRUD で、ドラッグ＆ドロップによる並べ替えに対応。パスワードは Fernet で暗号化して保存し、一覧にはマスクされたパスワードのみを表示、一時的な平文表示も可能
- **認証とロール**：Cloudflare Access が唯一のアイデンティティ源です。Worker が Access JWT を自ら検証し、AUD → admin（読み書き）/ viewer（読み取り専用）にマッピングします
- **監視（monitoring）**：`limooo-status` Worker が HTTP/D1 のターゲットを毎分プローブ（probe）し、プローブがダウンしている間は 10 秒ごとに再確認して、結果を D1 に保存します。アラートは webhook（フォールバックとして Email binding）で送信されます
- **ステータスページ**（`status.limooo.cn`）：同じ Worker が D1 からサーバーサイドレンダリングし、日ごとの稼働率は `probe_uptime_daily` ロールアップから取得します
- **自動 IP ブロック**：
  - D1 の `blocked_ips` が権威データです。`sync-worker` が有効な行を Cloudflare IP List に反映し、エッジで遮断します（オリジンがないため ipset/iptables はありません）
  - フォールバックとしてアプリケーション層のグローバルフィルタ — ブロックされた IP は直接 403 になります
- **統一リダイレクトページ**（`redirect.limooo.cn/?to=<https-url>`、`/r` も可）：任意の HTTPS 宛先へリダイレクトする前に中間ページを表示します
- **ポートフォリオ画像の扱い**：原本は一切公開されません。公開されるのはウォーターマーク入りのフル画像（`image.limooo.cn/portfolio/*`）とクリーンなサムネイルのみです

## 技術スタック

| レイヤー | 技術 | 実行環境 |
| --- | --- | --- |
| 公開ページ、ゲート、ビジターパネル、Apple Account マネージャー、ステータスページ | Pages Functions（`functions/`）+ 事前レンダリングされた静的 HTML | Cloudflare エッジ |
| データ | D1（訪問者分析、ブロックリスト、Apple Account アカウント、認証セッション、プローブ／ハートビート） | Cloudflare |
| 人間検証 | Cloudflare Turnstile、ゲートページをその場でレンダリング | Cloudflare + ブラウザ |
| 認証 | Cloudflare Access（Zero Trust JWT、Worker が自ら検証） | Cloudflare |
| 監視とデータ保持 | `ops/status-worker`（Cron Triggers + Durable Object alarms） | Cloudflare Workers |
| D1 アーカイブ | `ops/d1-archive`（毎日の cron） | Cloudflare Workers |
| ブロックリスト同期 | `ops/sync-worker`（日次 cron → Cloudflare IP List） | Cloudflare Workers |
| 画像ウォーターマーク | `ops/image-watermark`（パスを正規化するプロキシ） | Cloudflare Workers |
| 静的アセット／原本バックアップ | Pages アセットサーバー + プライベート R2 バケット `limooo-originals` | Cloudflare |
| デプロイ | `ops/deploy.sh`（git + `ops/pages_deploy.sh` + `ops/workers_deploy.sh`） | ローカル |

## プロジェクト構成

```
├── src/
│   ├── config.py          # unified config: paths, languages, domains, DB/IP utils (consumes config-contract.json)
│   ├── auto_block.py      # manual blocklist.txt → D1 reconciliation (D1 is the authority)
│   ├── cidr.py            # CIDR parsing helpers
│   ├── portfolio.py       # portfolio image / thumbnail helpers
│   ├── render_app.py      # build-time read-only renderer used by src/build.py
│   ├── services_pricing.py        # CSV-driven price list for services.limooo.cn
│   ├── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # auditable snapshot of D1 blocked_ips (D1 is the sole authority)
│   └── whitelist.txt      # trusted ASNs (low-risk) + fully allowed IPs/CIDRs
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
│   ├── run-tests.sh       # test runner used locally
│   ├── install_git_hooks.sh       # installs the pre-push hook
│   ├── readme_facts.py    # re-reads the facts on this page (--check / --live)
│   ├── migrate_d1.sh      # D1 migrations (--dry-run / --remote)
│   ├── workers_deploy.sh  # standalone Worker deploys
│   ├── export_d1.py       # unified D1 import SQL/JSON export (apple-account | blocklist)
│   ├── prune_d1.py        # manual D1 retention and aggregation (scheduled retention runs in status-worker)
│   ├── d1_client.py       # Cloudflare API client for D1
│   ├── upload_originals.sh        # private R2 backup of portfolio originals
│   ├── security-headers.json      # single source of the response-header baseline
│   ├── tailwind.config.js # Tailwind config for the prebuilt CSS
│   ├── check_config_contract.py / check_gate_trust.py / check_security_headers.py / check_ip_rays.py / check_ray_id.py / check_visitor_id.py
│   ├── migrations/        # D1 schema migrations
│   ├── waf/               # WAF rule snapshots
│   ├── cloudflare/        # Cloudflare resource inventory (declarative)
│   ├── email-templates/   # transactional email framework + i18n copy
│   ├── fonts/             # gate-diagnostic font subset
│   ├── status-worker/     # Worker: probes, status page, alerting, D1 retention
│   ├── image-watermark/   # Worker: image.limooo.cn watermark normalizer
│   ├── d1-archive/        # Worker: D1 snapshot/archive (cron 00:00)
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

## クイックスタート

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Build the static site locally
python3 src/build.py
```

快適な VS Code 環境のために、`.vscode/extensions.json` に記載されている推奨拡張機能（Jinja、Pylance）をインストールしてください。
ワークスペース設定が Jinja テンプレートを関連付けるため、
HTML/CSS/JS の診断がテンプレート構文を誤読しません。

生成されたサイトをローカルでプレビューするには、ビルドして `preview/` の出力を開きます。

## ビルド、テスト、デプロイ

クリーンなローカルビルドには、デプロイスクリプトと同じ依存関係セットを使用します：

```bash
cd site
npm ci
npm run build
```

`src/build.py` は `public/<lang>/*.html`、`public/static/`、
`functions/_data/i18n.ts`、`functions/_data/runtime.ts`、`preview/` を再生成します。
これらの出力を手で編集しないでください。`locales/*.json`、テンプレート、静的ソースを変更して再ビルドします。
`src/static/tailwind.css` はリポジトリにコミット済みの Tailwind ビルド済み出力です。
`npm run build` は `ops/build.sh` を使用し、これが `.venv-build` を作成して
 `public/manifest.json`（ビルド成果物のハッシュ証跡）を生成します。

Pages の出力だけをデプロイするには：

```bash
# build + validate only, no Cloudflare writes
bash ops/pages_deploy.sh --build-only

# build + validate + deploy Pages + smoke test (/_health must be 200)
bash ops/pages_deploy.sh

# full deploy: (1) commit (2) push (3) deploy Pages + docs
bash ops/deploy.sh --all
```

**デプロイ入口**：`ops/deploy.sh` が唯一のデプロイ入口です — commit + push +
Pages + docs を実行し、`--worker=<name>` で単一の Worker も配布できます。
`ops/pages_deploy.sh` がビルド + Pages を担当します。
`--dry-run` はどのリモートにも書き込まずに計画を出力します。

既定では `deploy.sh` は**静か（quiet）**です。1 ステップにつきステータス 1 行を出力し、そのステップの完全なログは
失敗したときにだけ吐き出されます。`--full` を付けるとすべてをストリーム出力します（ビルドマニフェスト、
成果物の数、wrangler のアップロード進捗）。どちらでもフラグとステップは同一で、
`--full` は冗長さだけを変えます。

認証情報はローカルの `secrets/webauthn.env` から読み込みます（コミットされず、
エコーもされません）。ssh / rsync / リモート systemd のステップはありません。
`ops/migrate_d1.sh` と `ops/workers_deploy.sh` も `--dry-run` に対応しています。

自動テストの入口を用意しています：

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## 環境変数

デプロイスクリプトが `secrets/webauthn.env` から読み込み、Git にはコミットされません。Pages ランタイムは独自のシークレット群を持ちます（後述のエッジのセクションを参照）。

| 変数 | 説明 |
| --- | --- |
| `GATE_HMAC_KEY` | `__gate` cookie 用の HMAC-SHA256 鍵。エッジで発行・検証します |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | `ops/d1_client.py`、`ops/pages_deploy.sh`、`ops/workers_deploy.sh` が使う Cloudflare API アクセス |

鍵素材はリポジトリの外に置きます。`apple_account_encryption.key` は Apple Account のパスワードと
暗号化された訪問者 IP カラムに使う Fernet 鍵です。

## Cron ジョブ

スケジューリングはすべて Cloudflare 上にあり、各 Worker の `wrangler.toml` で
宣言された Worker Cron Triggers として動作します：

| スケジュール | Worker | ジョブ |
| --- | --- | --- |
| `* * * * *` | `ops/status-worker` | 毎分の HTTP/D1 プローブ。プローブがダウンしている間は Durable Object のアラームが 10 秒ごとに再確認し、状態変化時にアラートします |
| `47 3 * * *` | `ops/status-worker` | D1 のデータ保持（`src/retention.ts`）：`ray_log_v2`（7 日）、`visitors_v2`（30 日）、`visitor_rollups`（30 日）、`heartbeats`（30 日）、`events`（90 日）、`probe_uptime_daily`（90 日）を削除します |
| `30 3 * * *` | `ops/sync-worker` | 有効な D1 `blocked_ips` の行を Cloudflare IP List `limooo_blocklist` に反映します |
| `0 0 * * *` | `ops/d1-archive` | D1 のスナップショット／アーカイブ |

`python3 ops/readme_facts.py --check` は上記のスケジュール、保持期間、TTL、ディレクトリツリーを
リポジトリから読み直し、このページと食い違えば失敗します。`--live` はデプロイ済みの状態
（D1 の件数、Pages のホストとシークレット、DNS、WAF、Worker のスケジュール）を Cloudflare
から読みます。

TLS 証明書は Cloudflare が Pages のカスタムドメイン向けに発行・更新します。
`ops/migrate_d1.sh` と `ops/workers_deploy.sh` は手動実行用で、
`--dry-run` に対応したメンテナンスの入口です。

## デプロイ

デプロイ対象は Cloudflare Pages（`limooo`）と独立した Workers で、すべて Cloudflare API 経由です。
リポジトリのルートから：

```bash
cd site
bash ops/deploy.sh              # with no arguments = --all (full deploy, see below)
bash ops/deploy.sh --all        # commit + push + deploy Pages + docs
bash ops/deploy.sh --pages      # deploy the main Pages project only
bash ops/deploy.sh --docs       # deploy docs.limooo.cn only
bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker
bash ops/deploy.sh --all --full             # same, but stream every step's output
```

`ops/deploy.sh` を**引数なしで実行すると、それは正確に `--all`** です：commit + push +
 Pages + docs、すなわち「完全デプロイ（full deploy）」の契約です。すでにローカルでコミット済みのものだけを配信するには、
`--pages` / `--docs` を明示的に指定します。

出力は既定で静かです（1 ステップにつきステータス 1 行）。`--full` を付けると全工程を確認できます。
`--dry-run` は上記のフラグのどの組み合わせでも動作します。

認証情報はローカルの `secrets/webauthn.env` から読み込みます。すべてのステップは
Cloudflare API か Git 経由で実行されます。

### ドキュメントサイト（docs.limooo.cn）

`site/docs/` は**サブドメインごとのコンテナ**です：`docs/` には docs.limooo.cn の
 VitePress ルート（1 ページ 1 言語につき 1 つの markdown ファイル）が入り、`services/` には
 services.limooo.cn の価格表 CSV が入ります。言語コードは URL の**最後**のセグメントで、
内容ページは常に明示的に付けます（`/README/zh-cn`、`/README/en-us`）。サフィックスなしの
`/README` は `/README/zh-cn` へ 302 で転送され、ホームの `/` だけが例外です。

`.vitepress/rewrites.json`（コンテンツの隣）がソースをサフィックス付きルートにマッピングし、
`.vitepress/config.mts` が `additionalConfig` を通じて各ページに固有の `lang` / `themeConfig` を与えます。
ページを追加するには、各言語ディレクトリに markdown ファイルを 1 つ置き、
rewrites のエントリと `public/_redirects` のサフィックスなしパス用 302 を 1 行足します —
markdown ファイルに HTML が出力されないと `ops/docs_check_output.py` がビルドを失敗させます。

サイトはフォーク `Limooooo-Studio/vitepress` の VitePress でビルドします。ヘッダーとフッターはフォーク側
（`VPLimoooNav.vue` / `VPLimoooFooter.vue`）にあり、メインサイトの `base.html` / `_footer.html` を忠実に再現しています —
 編集はフォークで行えば次のデプロイが反映します（フォークはコミットが変わったときだけ再ビルドされます。
フォークの作業ツリーからビルドするには `LIMOOO_VITEPRESS_FETCH=0` を使います）。
サイトは独立した Cloudflare Pages プロジェクト（`limooo-docs`）なので
メインの `limooo` 成果物には一切触れず、
`user_lang_preference` / `limooo_theme` cookie をメインサイトと共有します。

```bash
bash ops/docs_deploy.sh --build-only   # build + validate only
bash ops/docs_deploy.sh --dev          # local VitePress dev server
```

## セキュリティ設計

- セッション cookie は `Secure` + `HttpOnly` + `SameSite=Lax` を使用し、`.limooo.cn` にバインドされます。
  すべてのセッションは D1 `auth_sessions` に記録されたランダムな `sid` を持ち、`requireAuth` は
  失効・期限切れのセッションを拒否します。実行時に HMAC 鍵がない場合や `auth_sessions` テーブルが利用できない場合は、
  503 でフェイルクローズ（fail closed）します。
- ゲートも同様にフェイルクローズします。`TURNSTILE_SECRET`、`GATE_HMAC_KEY`、
  `SESSION_HMAC_KEY` のいずれかが空の場合、エッジはページをレンダリングしたり署名のない
   cookie を発行したりせず、503 を返します。
- `__gate` cookie は `<unix-expiry>.<HMAC-SHA256 hex>` です（TTL 1 時間、`HttpOnly`、
  `Domain=.limooo.cn`）。発行と検証はすべてエッジで行います。
- アイデンティティは Cloudflare Access から得ます。Worker が
   `Cf-Access-Jwt-Assertion` を自ら検証し（RS256、JWKS は 1 時間キャッシュ）、AUD → ロールにマッピングするため、
  Access が唯一のログイン窓口です。
- 鍵と暗号文は別々に保管し、リポジトリには決してコミットしません
- ブロックの層：アプリ層の D1 ブロックリストがエッジで 403 を返し、`ops/sync-worker` が
  有効な行を Cloudflare IP List `limooo_blocklist` に追随させます（WAF ルールが使う想定ですが、
  そのカスタムルールは現在デプロイされていません）
- 管理操作（作成／更新／削除）には admin ロールが必要で、viewer は読み取り専用です
- 訪問者の IP を一覧系 API が返すことはありません。完全な IP は `visitor_rollups.ip_enc` に
   Fernet で暗号化して保存し、admin 向けに 1 行ずつ復号します

## ホワイトリスト

信頼できるソースは [`data/whitelist.txt`](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/data/whitelist.txt) で管理し、1 行に 1 エントリを記述します：

| エントリ | 効果 |
| --- | --- |
| `ASN/<number>` | 低リスクのソース（中国電信／中国移動／中国聯通、鉄通とバックボーン AS9929 を含む）。Turnstile ゲートの代わりに Cloudflare の非対話型チャレンジ（`js_challenge`）を返す想定ですが、その WAF ルールは現在デプロイされていません（下記参照）。 |
| `IP-CIDR/<ip>/<mask>` | 完全に許可されたソース（例：`IP-CIDR/97.64.18.11/32`）。ブロックリストとチャレンジゲートの両方をスキップします。 |

ASN リストは [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn)（毎日更新）から取得します。生成されたエッジ側のコピーは現在 **320 件の低リスク ASN** と **2 件の完全許可 IP** を含みます。現時点でこれを参照する WAF カスタムルールはありません（ゾーンの `http_request_firewall_custom` フェーズは空で、`ops/waf/rules.snapshot.json` は再構築用に歴史的な `js_challenge` ルールを保持しています）。

ランタイムごとの信頼範囲：エッジのコードが信頼するのは `IP-CIDR` のエントリだけです
（`isGateTrustedIp` → `functions/_data/gateTrust.ts`）。`data/whitelist.txt` を編集したら、
ビルドでエッジ側のコピーを再生成してください（`bash ops/build.sh` が
`ops/check_gate_trust.py --emit` を実行します）。

## 唯一の情報源

- ユーザー向けの文字列：`locales/*.json`。`functions/_data/*` と API の i18n ルートはそこから生成されます。
- 共有ランタイム定数：`config-contract.json` がランタイム横断で合意された契約です。`src/config.py` と生成物 `functions/_lib/config.ts` の双方がこれを消費し、`ops/check_config_contract.py` が一致を強制します。
- ゲート／リダイレクトの文言：`locales/*.json` を `functions/_data/runtime.ts` 経由で。`src/build.py` がそれを組み立てます。
- D1 のスキーマとマイグレーション：`ops/migrations/*.sql`。ブロックの権威は `blocked_ips` のみです。
- セキュリティレスポンスヘッダーの基準（有効時）：`ops/security-headers.json`。
- デプロイとランタイムの境界：`ops/deploy.sh`。ランタイムは Cloudflare Pages と Workers のみです。

## Cloudflare Pages ランタイム

公開サイト（ホーム／サービス／お問い合わせ、ゲート、ビジターパネル、Apple Account マネージャー、`images.limooo.cn`、リダイレクト中継）は Cloudflare Pages Functions 上で動作し、ステータスページとすべてのスケジュールジョブも同様です。Pages ホストの DNS は `limooo.pages.dev` を指します。

ランタイムの分担：

| レイヤー | 技術 |
| --- | --- |
| エッジ／人間検証 | Pages Functions（`functions/_middleware.ts`） |
| Pages | ビルド時に事前レンダリングされた静的 HTML（多言語） |
| データ | D1（訪問者分析、ブロックリスト、Apple Account 管理、認証セッション） |
| 人間検証 | Cloudflare Turnstile、ゲートページをその場でレンダリング |
| 独立した Workers | `status.limooo.cn`（`limooo-status`：プローブ、ステータスページ、データ保持）、`image.limooo.cn`（`image-watermark`）、`limooo-blocklist-sync` |

### ビルドとディレクトリ構成

- `python3 src/build.py`：4 言語のページを `public/` に事前レンダリングし、
  `locales/*.json` を `functions/api/i18n/[lang].ts` としてインライン化し、共有の
   `functions/_data/runtime.ts`（ゲート／リダイレクトの i18n + プリロードアセット）を生成します
- `ops/migrations/001_init.sql`：D1 の初期スキーマ（`apple_accounts` / `blocked_ips` / `visitors`）
- `ops/export_d1.py`：D1 取り込み用 SQL を生成（出力は `ops/out/`、git 管理外）
- `ops/migrations/007_visitor_status_indexes.sql`：訪問者ステータスの絞り込み用に `(status, ts)` と `(status, ip_hash, ts)` インデックスを追加します
- `ops/sync-worker/`：毎日 03:30 の Worker cron が有効な D1 `blocked_ips` の行を Cloudflare IP List に同期します。`auto_block.py cf` は明示的なメンテナンス専用です
- 注記：Pages は `POST /logout/backchannel` を公開し、`sub` によって D1 `auth_sessions`
   を失効させます。

### 環境変数

**Pages プロジェクト設定 → 環境変数 → Encrypt（Secret）**で設定し、リポジトリにはコミットしません：

| 変数 | 目的 |
| --- | --- |
| `TURNSTILE_SITEKEY` | ゲートページの Turnstile ウィジェットの公開 sitekey |
| `TURNSTILE_SECRET` | サーバー側 siteverify のシークレット |
| `GATE_HMAC_KEY` | `__gate` cookie 用の HMAC-SHA256 署名鍵（`openssl rand -hex 32`） |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access のチームドメイン。検証に使う JWT の `iss` でもあります |
| `ACCESS_ADMIN_AUDS` / `ACCESS_VIEWER_AUDS` | admin / viewer ロールにマッピングする Access アプリケーションの AUD タグ（カンマ区切り、admin が優先） |
| `VISITOR_IP_KEY` | 暗号化された訪問者 IP 完全版カラム（`visitor_rollups.ip_enc`）用の Fernet 鍵 |
| `OBSERVABILITY_HMAC_KEY` | プライバシー最小化された訪問者 IP ハッシュの HMAC 鍵（`functions/_lib/tracking.ts`）。未設定だとゲートがフェイルクローズします |
| `SESSION_HMAC_KEY` | Pages のセッション cookie 署名鍵（`GATE_HMAC_KEY` とは別） |
| `APPLE_ACCOUNT_ENCRYPTION_KEY` | Fernet 鍵（`secrets/apple_account_encryption.key` から） |

ローカル開発：`.dev.vars.example` を `.dev.vars` にコピーして実際の値を記入します（git 管理外）。`ops/sync-worker` 用の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` は `wrangler secret put` で設定します。

### ゲートの挙動

すべてのリクエストで署名済み `__gate` cookie を確認します。Cloudflare の `botManagement.verifiedBot` は検証済み検索エンジンの信頼シグナルとして受理されますが、任意の `Googlebot`/`GPTBot` の User-Agent 文字列やクライアントが送ってきた `cf_clearance` cookie がゲートを迂回することはありません。低リスクの中国電信／移動／聯通の ASN は WAF の `js_challenge` 層向けに登録されているだけで（そのルールは現在デプロイされていません）、エッジのコードが完全なバイパスを信頼するのは生成されたホワイトリスト（`data/whitelist.txt` → `functions/_data/gateTrust.ts`）だけです。

未検証のリクエストには Turnstile ゲートページを**その場で**返します。ホストもパスも変わりません。ミドルウェアは要求された URL に `public/<lang>/auth.html` をステータス `403` でレンダリングし、`POST /__gate/verify` が同じオリジンで `Set-Cookie: __gate=…`（1 時間、`Domain=.limooo.cn`）を返し、その後ページが元のターゲットを再読み込みします。`auth.limooo.cn` はゲートのホストです — 自身のルートで同じページを配信し、`/__gate/config|diag|verify` エンドポイントを持ちます。

ゲートをレンダリングするすべてのホストは同じエッジコードで配信されるため、同期させる 2 つ目のゲート実装はありません。

ミドルウェアは正規化された D1 ブロックリストも適用し、プライバシーを最小化した訪問者分析を記録します。ゲートページは `no-store`/`noindex` で、ダーク／ライトテーマの切り替えに対応します。Turnstile ウィジェットは、それをレンダリングするすべてのホスト（`limooo.cn` のゲート用サブドメイン、`auth`、`status`、`visitor`、`apple`、`images` を含む）を登録する必要があります。

### ページ配信（クリーン URL、言語パスプレフィックスなし）

`src/build.py` が `public/<lang>/` を 4 言語で事前レンダリングします。ゲート通過後、ミドルウェアは **cookie > Accept-Language > CF region > en-US** の順で言語を選び、`env.ASSETS.fetch()` で該当ページを取得して URL をクリーンに保ちます：

- `limooo.cn/` → ホームページ、`limooo.cn/services` / `limooo.cn/contact` → それぞれ対応するページ
- `services.limooo.cn/` → サービスページ、`contact.limooo.cn/` → お問い合わせページ（サブドメインはメインサイトへの 301 なしで直接コンテンツを配信します）
- `visitor.limooo.cn/` → ビジターパネル（要ログイン）、`account.limooo.cn/apple` → Apple Account マネージャー（要ログイン）
- `images.limooo.cn/` → ポートフォリオギャラリー兼 favicon/ロゴ/QR のアセットホスト、`image.limooo.cn/portfolio/<img>` → 正規化 Worker によるウォーターマーク版（そのルートは `images.limooo.cn` へ 301）
- `www.limooo.cn` → メインサイトへ 301
- ナビのリンクは絶対サブドメイン URL（`https://services.limooo.cn` など）を維持します。言語切り替えは純粋にフロントエンドの `applyLang()` で、リロードも URL 変更もありません

### services.limooo.cn の価格表（CSV 駆動）

サービスの価格表は**マークアップではなくデータ**です：`src/build.py` はレンダリングのたびに
 `docs/services/*.csv` を読み（`src/services_pricing.py`）、`src/templates/services.html` の
プラングリッドを埋めます。価格を変更するには CSV を編集してデプロイするだけです —
 テンプレートの編集は不要です。

| ファイル | 列 | 埋める内容 |
| --- | --- | --- |
| `docs/services/convention.csv` | `shots,price[,bookable]` | 01 Convention、撮影枚数のティアごとにカード 1 枚 |
| `docs/services/outdoor.csv` | `type,people,price[,bookable]` | 02 Outdoor、スタジオ／屋外 × 1 人／2 人 |

CSV から取得するのは数値、ティアの集合、受付可否だけです。ラベル、
単位の接尾辞、注記ブロックは引き続き `locales/*.json` から取得します
（`plan_studio_solo`、`unit_per_shot` など）。

**`bookable`（任意の列）** は、取り消し線付きの価格スタイルと
注記ブロックのスタジオ行の両方を制御します：

- ティアごと：`no` → そのティアの価格は
   `class="plan-price strikethrough"` でレンダリングされます。`yes`、空のセル、または列自体が
  存在しない → 通常の価格
- 注記ブロック：**すべての** `studio` ティアが `no` なら、スタジオ行は一時停止の文言
  （`studio_paused`）を表示します。予約可能なスタジオティアが 1 つでもあれば、代わりに
   `studio_bookable` を表示します

つまり「一時的に受付停止」は端から端までデータです：`outdoor.csv` で `studio` を `no` から `yes` に変えれば、
次のデプロイで取り消し線*と*一時停止の注記の両方が消え、
テンプレートもロケールも編集する必要はありません。両者が食い違うことは決してありません。
それ以外の値（例：`maybe`）は黙って推測せず、ビルドを失敗させます。

**`price` が正の整数でない場合は `-` としてレンダリングされます。** プレースホルダーの
許可リストはありません。空欄、`N/A`、`TBD`、打ち間違い（`1OO`）、`0`、負の数は
いずれも「価格未公開」を意味します。カードは `CNY` プレフィックスと単位の接尾辞を
保ったまま数値だけが `-` になります（`CNY - / 枚`）。レイアウトは数値のティアと
まったく同じです。`-` は `0` でも「無料」でもありません。1 つのファイルにこのような
セルと数値の行を混在させても問題ありません。

契約の残りの部分は次のとおりです：

- convention の行は CSV の**撮影枚数の昇順**で並びます。ティアの数は
  固定ではありません（12 枚の行を追加してもコード変更は不要）
- convention のティアに単位の接尾辞が付くのは
   `CONVENTION_UNIT_KEYS` に登録されている場合だけです。未登録のティアは価格のみをレンダリングします
- outdoor の行は 4 つの `type/people` の組み合わせをすべて網羅する必要があります。行の順序に関係なく
  固定の順序（スタジオ 1 人／2 人、次に屋外 1 人／2 人）でレンダリングされます

ファイルの欠落、列の誤り、ティアの重複、未知のティア、認識できない `bookable` の値は
**ビルドを失敗させます** — 誤った価格表はビルドの失敗よりも悪いからです。価格セルだけは
ビルドを失敗させません。正の整数として解釈できない内容はすべて `-` として
レンダリングされます。
`tests/test_services_pricing.py` はこれらのすべてのケースと、コミットされた CSV に対するラウンドトリップ
検査をカバーします。

`docs/services/` は VitePress のビルドから除外されるため（`docs/.vitepress/config.mts` の
 `srcExclude`）、CSV はデータソースのままで、
docs.limooo.cn に公開されることはありません。

### パフォーマンス／エッジキャッシュ

- `public/_routes.json` は `/static/*` とルートの静的アセットを Pages
   Functions から除外するため、CSS/JS/フォントは Pages アセットサーバーが直接配信します。
- `public/_headers` はバージョン付きの静的アセットに
   `stale-while-revalidate` 付きの長いブラウザキャッシュを与えます。`public/_routes.json` と `_headers` は
  どちらも `src/build.py` が生成します。
- 検証済みの公開 HTML は Pages Cache API に言語ごとに 300
   秒キャッシュされ、レスポンスは `public, max-age=300, s-maxage=300, stale-while-revalidate=3600` と
   `Vary: Accept-Language, Cookie` を通知します。
- ファーストパーティのポートフォリオサムネイルと favicon は、
  ウォーターマーク Worker ではなく `images.limooo.cn/static/...`（静的エッジキャッシュ、Functions を迂回）
  を使用します。QR コードと外部から直リンクされた画像は
  引き続き `image.limooo.cn` を使用します。
- ポートフォリオの原本は一切公開されません：`/static/portfolio/<img>` は 404 を返します。
  公開されるのはクリーンなサムネイル（`images.limooo.cn/static/portfolio/thumbs/<img>-<width>.{webp,avif}`）と、
  `image.limooo.cn` の正規化・ウォーターマーク済み `/portfolio/<img>` だけです。
  原本は git 管理外の `src/static/portfolio/` とプライベート R2 バケット
   `limooo-originals`（`ops/upload_originals.sh`）に残ります。
- Turnstile の検証にはサーバー側で 3 秒のタイムアウトがあるため、
  Cloudflare のチャレンジ基盤の障害時はユーザーを最大 8 秒待たせず、
  素早くフェイルクローズします。

### 本番の状態

デプロイ済みの構成です。`python3 ops/readme_facts.py --live` でいつでも読み直せます：

1. **Pages**：プロジェクト `limooo`（`limooo.pages.dev`）が `limooo.cn`、`www`、`services`、`contact`、`auth`、`visitor`、`account`、`identity`、`images`、`redirect` を配信します。ドキュメントサイトは別プロジェクト `limooo-docs`（`docs.limooo.cn`）で、`fonts.limooo.cn` は R2 が支えます
2. **D1**：データベース `limooo`（APAC）が `DB` としてプロジェクトに接続されています。`ops/migrations/` のスキーマは適用済みで、適用バージョンは `schema_version` が記録します。`apple_accounts` が Apple Account の行を保持し、`blocked_ips` がブロックの権威です（83 行、有効 1 行。ソフト削除した行は監査用に残ります）
3. **シークレット**は **Pages → Settings → Environment variables → Encrypt** にあります：Turnstile の 2 つ、`GATE_HMAC_KEY`、`SESSION_HMAC_KEY`、`OBSERVABILITY_HMAC_KEY`、`VISITOR_IP_KEY`、`APPLE_ACCOUNT_ENCRYPTION_KEY`、`ACCESS_*` バインディング。`APPLEID_ENCRYPTION_KEY` と 2 つの `AUTHENTIK_*` はどのランタイムも読まない残骸です
4. **Access** が `visitor.limooo.cn`、`account.limooo.cn`、`admin.limooo.cn` を self-hosted アプリとして前段で保護します。自前の IdP も独自のログインフォームもありません
5. **Worker** は独立して動作します：`limooo-status`、`limooo-blocklist-sync`、`limooo-d1-archive`、`image-watermark`。`status.limooo.cn` と `sink.limooo.cn` は Worker のカスタムドメインです
6. **Cloudflare のルール**：カスタムファイアウォールのフェーズは空です（`limooo_blocklist` IP List はルールを待っている状態）。キャッシュのフェーズでは静的アセット、旧画像パス、ウォーターマーク Worker の応答を 1 年間キャッシュし、2 つの HTML ページキャッシュルールは無効です。動的リダイレクトのフェーズは空で、`ops/waf/rules.snapshot.json` が再構築用に過去の WAF ルールセットを保持します
7. **スモークチェック**：`https://limooo.cn/_health` → 200、`https://limooo.cn/?challenge=1` → 403、`https://docs.limooo.cn/` と `https://status.limooo.cn/` → 200

ゲートはどのホストでもその場でレンダリングされ、ゲートページとログに実際の訪問者 IP が表示され、Access が唯一のアイデンティティ源であり続けます。
## ライセンス

[GNU AGPL v3.0](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE.md)|[GNU AGPL v3.0-簡体字中国語](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_zh_CN.md)|[GNU AGPL v3.0-日本語](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ja_JP.md)|[GNU AGPL v3.0-韓国語](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ko_KR.md)
