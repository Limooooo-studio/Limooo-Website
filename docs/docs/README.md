---
aside: false
title: 项目说明
description: "Limooo 网站与管理系统（Cloudflare 全无服务器架构）的项目 README"
---

# Limooo

一个完全无服务器的个人网站与管理系统，运行在 [limooo.cn](https://limooo.cn)。公开页面、人类验证门禁、访客面板、Apple Account 管理器、监控与状态页全部运行在 Cloudflare 上（Pages Functions、Workers、D1、R2）。

## 功能特性

- **公开页面**：首页、服务、联系、作品集 —— 以 4 种语言预渲染，支持深色/浅色主题切换
- **人类验证**：Turnstile 门禁页在所有主机上都**原地**渲染在请求的 URL 上（不跨域跳转）—— 见 [门禁行为](#门禁行为)
- **访客面板**（`visitor.limooo.cn`）：Pages Function + D1 分析；显示经过哈希处理的访客标识（列表接口不返回原始 IP）、国家/地区、可获取时的 ISP/ASN、状态码分布，并受登录保护
- 首次加载之后，访客状态筛选标签在本地过滤，不再发起新的 `/api/visitors` 请求；API 仍然接受 `?status=<3-digit>` 以支持深链接
- **Apple Account 管理器**（`account.limooo.cn/apple`）：Pages Function + D1 增删改查，支持拖拽排序；密码使用 Fernet 加密存储，列表中只显示掩码后的密码，并支持临时明文查看
- **认证与角色**：Cloudflare Access 是唯一的身份来源；Worker 自行验证 Access JWT，并把 AUD 映射为 admin（读写）/ viewer（只读）
- **监控**：`limooo-status` Worker 每分钟探测（probe）HTTP/D1 目标，探针处于故障状态时每 10 秒重新检查一次，并把结果存入 D1；告警通过 webhook 发出（Email binding 作为后备）
- **状态页**（`status.limooo.cn`）：由同一个 Worker 从 D1 服务端渲染，每日在线率取自 `probe_uptime_daily` 汇总表
- **自动 IP 封禁**：
  - D1 `blocked_ips` 是权威数据源；`sync-worker` 把生效的行同步到 Cloudflare IP List，用于边缘拦截（没有源站，因此也不需要 ipset/iptables）
  - 应用层全局过滤器作为后备 —— 被封禁的 IP 直接收到 403
- **统一跳转页**（`redirect.limooo.cn/?to=<https-url>`，也接受 `/r`）：在跳转到任意 HTTPS 目标之前显示一个中转提示页
- **作品集图片处理**：原图永不对外发布；只有加水印的完整图片（`image.limooo.cn/portfolio/*`）和干净的缩略图是公开的

## 技术栈

| 层 | 技术 | 运行位置 |
| --- | --- | --- |
| 公开页面、门禁、访客面板、Apple Account 管理器、状态页 | Pages Functions（`functions/`）+ 预渲染静态 HTML | Cloudflare 边缘 |
| 数据 | D1（访客分析、黑名单、Apple Account 账号、认证会话、探针/心跳） | Cloudflare |
| 人类验证 | Cloudflare Turnstile，门禁页原地渲染 | Cloudflare + 浏览器 |
| 认证 | Cloudflare Access（Zero Trust JWT，由 Worker 自行验证） | Cloudflare |
| 监控与数据保留 | `ops/status-worker`（Cron Triggers + Durable Object alarms） | Cloudflare Workers |
| D1 归档 | `ops/d1-archive`（每日 cron） | Cloudflare Workers |
| 黑名单同步 | `ops/sync-worker`（每日 cron → Cloudflare IP List） | Cloudflare Workers |
| 图片水印 | `ops/image-watermark`（路径归一化代理） | Cloudflare Workers |
| 静态资源 / 原图备份 | Pages 资源服务器 + 私有 R2 桶 `limooo-originals` | Cloudflare |
| 部署 | `ops/deploy.sh`（git + `ops/pages_deploy.sh` + `ops/workers_deploy.sh`） | 本地 |

## 项目结构

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

## 快速开始

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Build the static site locally
python3 src/build.py
```

为获得干净的 VS Code 体验，请安装 `.vscode/extensions.json` 中列出的推荐扩展
（Jinja、Pylance）；工作区设置已关联 Jinja 模板，
因此 HTML/CSS/JS 诊断不会误读模板语法。

若要在本地预览生成后的站点，请先构建，然后打开 `preview/` 中的产物。

## 构建、测试与部署

为获得干净的本地构建，请使用与部署脚本相同的依赖集合：

```bash
cd site
npm ci
npm run build
```

`src/build.py` 会重新生成 `public/<lang>/*.html`、`public/static/`、
`functions/_data/i18n.ts`、`functions/_data/runtime.ts` 与 `preview/`。
不要手动编辑这些产物；应修改 `locales/*.json`、模板或静态源文件后重新构建。
`src/static/tailwind.css` 是已入库的 Tailwind 预构建产物。
`npm run build` 使用 `ops/build.sh`，它会创建 `.venv-build`
并生成 `public/manifest.json`（构建产物哈希凭据）。

只部署 Pages 产物时使用：

```bash
# build + validate only, no Cloudflare writes
bash ops/pages_deploy.sh --build-only

# build + validate + deploy Pages + smoke test (/_health must be 200)
bash ops/pages_deploy.sh

# full deploy: (1) commit (2) push (3) deploy Pages + docs
bash ops/deploy.sh --all
```

**部署入口**：`ops/deploy.sh` 是唯一的部署入口 —— commit + push + Pages + docs，
并可用 `--worker=<name>` 单独部署一个 Worker；`ops/pages_deploy.sh` 负责构建 + Pages。
`--dry-run` 只打印计划，不向任何远端写入。

默认情况下 `deploy.sh` 是**安静模式**：每个步骤一行状态，
只有该步骤失败时才输出它的完整日志。加上 `--full` 可流式输出全部内容
（构建清单、产物数量、wrangler 上传进度）。两种模式下标志与步骤完全相同 ——
`--full` 只改变详细程度。

凭据从本地 `secrets/webauthn.env` 读取（从不提交、从不回显）；
没有 ssh / rsync / 远端 systemd 步骤。`ops/migrate_d1.sh` 与
`ops/workers_deploy.sh` 也支持 `--dry-run`。

已提供自动化测试入口：

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## 环境变量

由部署脚本从 `secrets/webauthn.env` 读取，不提交到 Git。Pages 运行时有一套自己的 Secret（见下文的边缘章节）。

| 变量 | 说明 |
| --- | --- |
| `GATE_HMAC_KEY` | `__gate` cookie 的 HMAC-SHA256 密钥，在边缘签发并校验 |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 供 `ops/d1_client.py`、`ops/pages_deploy.sh` 与 `ops/workers_deploy.sh` 使用的 Cloudflare API 访问凭据 |

密钥材料存放在仓库之外；`apple_account_encryption.key` 是用于 Apple Account 密码
与加密访客 IP 字段的 Fernet 密钥。

## 定时任务

所有调度都位于 Cloudflare 上，以各 Worker 的 `wrangler.toml` 中声明的
Worker Cron Triggers 形式存在：

| 调度 | Worker | 任务 |
| --- | --- | --- |
| `* * * * *` | `ops/status-worker` | 每分钟执行 HTTP/D1 探针；探针故障期间由 Durable Object alarm 每 10 秒复查一次，并在状态变化时告警 |
| `47 3 * * *` | `ops/status-worker` | D1 数据保留（`src/retention.ts`）：清理 `ray_log_v2`（7 天）、`visitors_v2`（30 天）、`visitor_rollups`（30 天）、`heartbeats`（30 天）、`events`（90 天）与 `probe_uptime_daily`（90 天） |
| `30 3 * * *` | `ops/sync-worker` | 把生效的 D1 `blocked_ips` 行同步到 Cloudflare IP List `limooo_blocklist` |
| `0 0 * * *` | `ops/d1-archive` | D1 快照 / 归档 |

`python3 ops/readme_facts.py --check` 会从仓库重新读一遍上面的调度、保留期、TTL 与目录树，
与本页不一致就让检查失败；`--live` 则从 Cloudflare 读线上状态（D1 计数、Pages 主机与
Secret、DNS、WAF、Worker 调度）。

TLS 证书由 Cloudflare 为 Pages 自定义域名签发与续期。
`ops/migrate_d1.sh` 与 `ops/workers_deploy.sh` 是手动的、
支持 `--dry-run` 的维护入口。

## 部署

部署目标就是 Cloudflare Pages（`limooo`）以及各个独立 Worker，全部走 Cloudflare API。
在仓库根目录下执行：

```bash
cd site
bash ops/deploy.sh              # with no arguments = --all (full deploy, see below)
bash ops/deploy.sh --all        # commit + push + deploy Pages + docs
bash ops/deploy.sh --pages      # deploy the main Pages project only
bash ops/deploy.sh --docs       # deploy docs.limooo.cn only
bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker
bash ops/deploy.sh --all --full             # same, but stream every step's output
```

不带任何参数运行 `ops/deploy.sh` **完全等同于 `--all`**：commit + push + Pages +
docs，即「完整部署」契约。若要只发布本地已提交的内容，
请显式传入 `--pages` / `--docs`。

输出默认是安静模式（每步一行状态）；加上 `--full` 可观察整个过程。
`--dry-run` 可与上述任意标志组合使用。

凭据从本地 `secrets/webauthn.env` 读取；所有步骤都走 Cloudflare API 或 Git。

### 文档站（docs.limooo.cn）

`site/docs/` 是一个**按子域分目录的容器**：`docs/` 存放 docs.limooo.cn 的
VitePress 根（每种语言每页一个 markdown 文件），
`services/` 存放 services.limooo.cn 的价目表 CSV。
语言码是 URL 的**最后**一段，内容页一律显式带上（`/README/zh-cn`、`/README/en-us`）；
无后缀的 `/README` 会 302 到 `/README/zh-cn`，首页 `/` 是唯一例外。

`.vitepress/rewrites.json`（与内容同级）把源文件映射到带后缀的路由，
`.vitepress/config.mts` 通过 `additionalConfig` 为每个页面设置各自的
`lang` / `themeConfig`。新增页面时，只需在每个语言目录中各放一个 markdown 文件，再加一条 rewrites 条目，
并在 `public/_redirects` 里为无后缀路径补一条 302 —— 如果任何 markdown 文件没有产出 HTML，
`ops/docs_check_output.py` 会让构建失败。

该站点使用来自 fork `Limooooo-Studio/vitepress` 的 VitePress 构建：
页头与页脚位于 fork 中（`VPLimoooNav.vue` / `VPLimoooFooter.vue`），
并与主站的 `base.html` / `_footer.html` 逐条对齐 —— 在那里修改它们，
下一次部署就会生效（只有当 fork 的 commit 变化时才会重新构建它；
使用 `LIMOOO_VITEPRESS_FETCH=0` 可从 fork 工作区构建）。该站点是独立的
Cloudflare Pages 项目（`limooo-docs`），因此绝不会碰到主 `limooo` 的产物，
并且与主站共享 `user_lang_preference` / `limooo_theme` 两个 cookie。

```bash
bash ops/docs_deploy.sh --build-only   # build + validate only
bash ops/docs_deploy.sh --dev          # local VitePress dev server
```

## 安全设计

- 会话 cookie 使用 `Secure` + `HttpOnly` + `SameSite=Lax`，绑定到 `.limooo.cn`；
  每个会话都有一个随机 `sid` 记录在 D1 `auth_sessions` 中，`requireAuth`
  会拒绝已撤销/已过期的会话。运行时 HMAC 密钥缺失或 `auth_sessions` 表
  不可用时，以 503 快速失败。
- 门禁同样快速失败：当 `TURNSTILE_SECRET`、`GATE_HMAC_KEY` 或
  `SESSION_HMAC_KEY` 为空时，边缘返回 503，
  而不是渲染页面或签发未签名的 cookie。
- `__gate` cookie 的形式是 `<unix-expiry>.<HMAC-SHA256 hex>`（1 小时 TTL，
  `HttpOnly`，`Domain=.limooo.cn`），完全在边缘签发与校验。
- 身份来自 Cloudflare Access：Worker 自行验证 `Cf-Access-Jwt-Assertion`
  （RS256，JWKS 缓存 1 小时），并把 AUD 映射为角色，
  Access 因此是唯一的登录入口。
- 密钥与密文分开存储，且从不提交到仓库
- 封禁层级：应用层的 D1 黑名单在边缘直接 403，`ops/sync-worker` 把生效行同步到
  Cloudflare IP List `limooo_blocklist` 供 WAF 规则使用（该自定义规则目前未部署）
- 管理写入（创建/更新/删除）需要 admin 角色；viewer 为只读
- 列表接口永不返回访客 IP；完整 IP 以 Fernet 加密存放在 `visitor_rollups.ip_enc` 中，
  仅对管理员逐行解密

## 白名单

可信来源维护在 [`data/whitelist.txt`](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/data/whitelist.txt) 中，每行一条：

| 条目 | 效果 |
| --- | --- |
| `ASN/<number>` | 低风险来源（中国电信 / 中国移动 / 中国联通，含铁通与骨干网 AS9929）。本应下发 Cloudflare 非交互式质询（Non-Interactive Challenge，`js_challenge`）而不是 Turnstile 门禁；该 WAF 规则目前未部署（见下）。 |
| `IP-CIDR/<ip>/<mask>` | 完全放行的来源（例如 `IP-CIDR/97.64.18.11/32`）；同时跳过黑名单与质询门禁。 |

ASN 列表来源于 [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn)（每日更新）。生成的边缘副本当前包含 **320 个低风险 ASN** 与 **2 个完全放行 IP**。目前没有任何 WAF 自定义规则在用它：该区域的 `http_request_firewall_custom` 阶段是空的，`ops/waf/rules.snapshot.json` 只保留历史 `js_challenge` 规则供重建。

各运行时的信任范围：边缘代码只把 `IP-CIDR` 条目视为可信（`isGateTrustedIp` →
`functions/_data/gateTrust.ts`）。修改 `data/whitelist.txt` 之后，通过一次构建重新生成边缘副本
（`bash ops/build.sh`，它会跑 `ops/check_gate_trust.py --emit`）。

## 权威来源

- 面向用户的文案：`locales/*.json`；`functions/_data/*` 与 API 的 i18n 路由都由它生成。
- 共享运行时常量：`config-contract.json` 是约定的跨运行时契约；`src/config.py` 与生成的 `functions/_lib/config.ts` 都消费它，并由 `ops/check_config_contract.py` 强制保持一致。
- 门禁/跳转文案：经由 `functions/_data/runtime.ts` 来自 `locales/*.json`；由 `src/build.py` 组装。
- D1 结构与迁移：`ops/migrations/*.sql`；`blocked_ips` 是封禁的唯一权威。
- 安全响应头基线（启用时）：`ops/security-headers.json`。
- 部署与运行时边界：`ops/deploy.sh`；只有 Cloudflare Pages + Workers 两个运行时。

## Cloudflare Pages 运行时

公开站点（首页 / 服务 / 联系、门禁、访客面板、Apple Account 管理器、`images.limooo.cn` 与跳转中继）运行在 Cloudflare Pages Functions 上，状态页与所有定时任务也是如此。Pages 各主机的 DNS 都指向 `limooo.pages.dev`。

运行时划分：

| 层 | 技术 |
| --- | --- |
| 边缘 / 人类验证 | Pages Functions（`functions/_middleware.ts`） |
| 页面 | 构建时预渲染的静态 HTML（多语言） |
| 数据 | D1（访客分析、黑名单、Apple Account 管理、认证会话） |
| 人类验证 | Cloudflare Turnstile，门禁页原地渲染 |
| 独立 Worker | `status.limooo.cn`（`limooo-status`：探针、状态页、数据保留）、`image.limooo.cn`（`image-watermark`）、`limooo-blocklist-sync` |

### 构建与目录结构

- `python3 src/build.py`：把页面以 4 种语言预渲染到 `public/`，把 `locales/*.json`
  内联为 `functions/api/i18n/[lang].ts`，并生成共享的 `functions/_data/runtime.ts`
  （门禁/跳转 i18n + 预加载资源）
- `ops/migrations/001_init.sql`：D1 初始结构（`apple_accounts` / `blocked_ips` / `visitors`）
- `ops/export_d1.py`：生成 D1 导入 SQL（输出在 `ops/out/`，已被 git 忽略）
- `ops/migrations/007_visitor_status_indexes.sql`：为访客状态筛选新增 `(status, ts)` 与 `(status, ip_hash, ts)` 索引
- `ops/sync-worker/`：每日 03:30 的 Worker cron 把生效的 D1 `blocked_ips` 行同步到 Cloudflare IP List；`auto_block.py cf` 仅用于显式的人工维护
- 注意：Pages 暴露 `POST /logout/backchannel`，并按 `sub` 撤销 D1 `auth_sessions`。

### 环境变量

配置在 **Pages 项目设置 → 环境变量 → 加密（Secret）** 下，不提交到仓库：

| 变量 | 用途 |
| --- | --- |
| `TURNSTILE_SITEKEY` | 门禁页上 Turnstile 组件的公开 sitekey |
| `TURNSTILE_SECRET` | 服务端 siteverify 密钥 |
| `GATE_HMAC_KEY` | `__gate` cookie 的 HMAC-SHA256 签名密钥（`openssl rand -hex 32`） |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access 团队域名；同时也是用于验证的 JWT `iss` |
| `ACCESS_ADMIN_AUDS` / `ACCESS_VIEWER_AUDS` | 逗号分隔的 Access 应用 AUD 标签，映射到 admin / viewer 角色（admin 优先） |
| `VISITOR_IP_KEY` | 用于加密完整访客 IP 字段（`visitor_rollups.ip_enc`）的 Fernet 密钥 |
| `OBSERVABILITY_HMAC_KEY` | 隐私最小化访客 IP 哈希的 HMAC 密钥（`functions/_lib/tracking.ts`）；缺失时门禁 fail-closed |
| `SESSION_HMAC_KEY` | Pages 会话 cookie 签名密钥（与 `GATE_HMAC_KEY` 分开） |
| `APPLE_ACCOUNT_ENCRYPTION_KEY` | Fernet 密钥（来自 `secrets/apple_account_encryption.key`） |

本地开发：把 `.dev.vars.example` 复制为 `.dev.vars` 并填入真实值（已被 git 忽略）。通过 `wrangler secret put` 为 `ops/sync-worker` 配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。

### 门禁行为

每个请求都会检查已签名的 `__gate` cookie。Cloudflare 的 `botManagement.verifiedBot` 被视为经过验证的搜索引擎信任信号；任意伪造的 `Googlebot`/`GPTBot` User-Agent 字符串以及客户端自带的 `cf_clearance` cookie 都不能绕过门禁。低风险的中国电信 / 移动 / 联通 ASN 只是登记给 WAF 的 `js_challenge` 层使用（该规则目前未部署），而边缘代码只信任生成的白名单（`data/whitelist.txt` → `functions/_data/gateTrust.ts`）来做完全绕过。

未验证的请求会**原地**获得 Turnstile 门禁页：主机与路径始终不变。中间件在请求的 URL 上以状态码 `403` 渲染 `public/<lang>/auth.html`，`POST /__gate/verify` 在同一来源上返回 `Set-Cookie: __gate=…`（1 小时，`Domain=.limooo.cn`），随后页面重新加载最初的目标地址。`auth.limooo.cn` 是门禁主机 —— 它在自己的根路径上提供同一个页面，且拥有 `/__gate/config|diag|verify` 端点。

每个渲染门禁的主机都由同一份边缘代码提供服务，因此不存在需要保持同步的第二套门禁实现。

中间件还会强制执行归一化后的 D1 黑名单，并记录隐私最小化的访客分析数据。门禁页为 `no-store`/`noindex`，并支持深色/浅色主题切换。Turnstile 组件必须列出所有渲染它的主机（`limooo.cn` 的门禁子域，包括 `auth`、`status`、`visitor`、`apple` 与 `images`）。

### 页面服务（干净 URL，无语言路径前缀）

`src/build.py` 以 4 种语言预渲染 `public/<lang>/`；门禁通过之后，中间件按 **cookie > Accept-Language > CF 区域 > en-US** 的顺序选择语言，并通过 `env.ASSETS.fetch()` 获取匹配的页面，从而保持 URL 干净：

- `limooo.cn/` → 首页；`limooo.cn/services` / `limooo.cn/contact` → 对应页面
- `services.limooo.cn/` → 服务页；`contact.limooo.cn/` → 联系页（子域直接提供内容，不 301 到主站）
- `visitor.limooo.cn/` → 访客面板（需要登录）；`account.limooo.cn/apple` → Apple Account 管理器（需要登录）
- `images.limooo.cn/` → 作品集画廊，同时是 favicon/logo/二维码的资源主机；`image.limooo.cn/portfolio/<img>` → 来自归一化 Worker 的加水印版本（其根路径 301 到 `images.limooo.cn`）
- `www.limooo.cn` → 301 到主站
- 导航链接保持绝对子域 URL（`https://services.limooo.cn` 等）；语言切换是纯前端的 `applyLang()`，不重新加载、不改变 URL

### services.limooo.cn 价目表（CSV 驱动）

服务价目表是**数据，而不是标记**：`src/build.py` 在每次渲染时读取
`docs/services/*.csv`（`src/services_pricing.py`），并填充
`src/templates/services.html` 中的套餐网格。改价格就意味着改 CSV 然后部署 ——
不需要改模板。

| 文件 | 列 | 填充内容 |
| --- | --- | --- |
| `docs/services/convention.csv` | `shots,price[,bookable]` | 01 场照拍摄（Convention），每个张数档位一张卡片 |
| `docs/services/outdoor.csv` | `type,people,price[,bookable]` | 02 正片拍摄（Outdoor），棚拍/外景 × 单人/双人 |

只有数字、档位集合与 `bookable` 列来自 CSV；
标签、单位后缀与说明栏仍然来自 `locales/*.json`
（`plan_studio_solo`、`unit_per_shot` 等）。

**`bookable`（可选列）** 同时驱动删除线价格样式
与说明栏中的棚拍行：

- 按档位：`no` → 该档价格渲染时带
  `class="plan-price strikethrough"`；
  `yes`、空单元格或整列缺失 → 正常价格
- 说明栏：如果**所有**棚拍档位都是 `no`，棚拍行显示暂停文案
  （`studio_paused`）；只要有一个棚拍档位可预约，
  就改显示 `studio_bookable`

因此「暂时不接单」是端到端的数据：把 `outdoor.csv` 中棚拍的 `no` 改成 `yes`，
删除线*与*暂停说明会在下一次部署时同时消失，无需改动模板或语言文件。
两者永远不会互相矛盾。任何其它取值（例如 `maybe`）都会让构建失败，
而不是默默猜测。

**`price` 不是正整数时一律渲染成 `-`。** 没有占位符白名单：留空、`N/A`、`TBD`、
写错的数字（`1OO`）、`0`、负数都表示「价格暂不公开」。卡片保留 `CNY` 前缀与
单位后缀，只把数字换成 `-`（`CNY - / 张`），因此版式与数字档位完全一致。
`-` 既不是 `0` 也不是「免费」；在同一个文件里混用这类单元格与数字行没有问题。

契约的其余部分：

- 场照拍摄的行按**张数升序**来自 CSV；档位数量不固定
  （新增一个 12 张的档位不需要改代码）
- 只有当某个场照拍摄档位登记在 `CONVENTION_UNIT_KEYS` 中时才会带单位后缀；
  未登记的档位只渲染裸价格
- 正片拍摄的行必须覆盖全部四种 `type/people` 组合；无论行序如何，
  它们都按固定顺序渲染（棚拍单人/双人，然后外景单人/双人）

文件缺失、列不正确、档位重复、档位无法识别或 `bookable` 取值非法，
都会**让构建失败** —— 价目表出错比构建失败更严重。价格单元格本身永远不会让
构建失败：解析不出正整数的内容一律渲染成 `-`。
`tests/test_services_pricing.py` 覆盖了上述所有情况，并包含一项针对已入库 CSV 的
往返校验。

`docs/services/` 已被排除在 VitePress 构建之外
（`docs/.vitepress/config.mts` 中的 `srcExclude`），因此这些 CSV 始终只是数据源，
绝不会发布到 docs.limooo.cn。

### 性能 / 边缘缓存

- `public/_routes.json` 把 `/static/*` 与根级静态资源排除在 Pages Functions 之外，
  因此 CSS/JS/字体由 Pages 资源服务器直接提供。
- `public/_headers` 为带版本号的静态资源设置带 `stale-while-revalidate`
  的长浏览器缓存；`public/_routes.json` 与 `_headers`
  都由 `src/build.py` 生成。
- 已验证的公开 HTML 按语言在 Pages Cache API 中缓存 300 秒，
  响应会声明 `public, max-age=300, s-maxage=300, stale-while-revalidate=3600`
  并带上 `Vary: Accept-Language, Cookie`。
- 第一方作品集缩略图与 favicon 使用 `images.limooo.cn/static/...`
  （静态边缘缓存，绕过 Functions），而不是水印 Worker；
  二维码与外部热链图片
  仍然使用 `image.limooo.cn`。
- 作品集原图永不发布：`/static/portfolio/<img>` 返回 404。
  只有干净的缩略图（`images.limooo.cn/static/portfolio/thumbs/<img>-<width>.{webp,avif}`）
  与 `image.limooo.cn` 上归一化、加水印的 `/portfolio/<img>` 是公开的；
  原图保留在被 git 忽略的 `src/static/portfolio/` 与私有 R2 桶
  `limooo-originals` 中（`ops/upload_originals.sh`）。
- Turnstile 验证有 3 秒的服务端超时，
  这样 Cloudflare 质询平台故障时会快速失败，
  而不是让用户最多卡住 8 秒。

### 生产状态

线上部署的形态，随时可用 `python3 ops/readme_facts.py --live` 重新读取：

1. **Pages**：项目 `limooo`（`limooo.pages.dev`）承载 `limooo.cn`、`www`、`services`、`contact`、`auth`、`visitor`、`account`、`identity`、`images` 与 `redirect`；文档站是独立的 `limooo-docs` 项目（`docs.limooo.cn`），`fonts.limooo.cn` 由 R2 提供
2. **D1**：数据库 `limooo`（APAC）以 `DB` 绑定到该项目；`ops/migrations/` 的 schema 已就位，已应用版本记录在 `schema_version`；`apple_accounts` 保存 Apple Account 数据，`blocked_ips` 是封禁权威（83 行、1 行生效 —— 软删除行保留用于审计）
3. **Secret** 位于 **Pages → Settings → Environment variables → Encrypt**：Turnstile 两个密钥、`GATE_HMAC_KEY`、`SESSION_HMAC_KEY`、`OBSERVABILITY_HMAC_KEY`、`VISITOR_IP_KEY`、`APPLE_ACCOUNT_ENCRYPTION_KEY` 与 `ACCESS_*` 绑定；`APPLEID_ENCRYPTION_KEY` 与两个 `AUTHENTIK_*` 是没有任何运行时代码读取的历史遗留
4. **Access** 以前置自建应用（self-hosted）保护 `visitor.limooo.cn`、`account.limooo.cn` 与 `admin.limooo.cn`；没有自建 IdP，也没有自定义登录页
5. **Worker** 独立运行：`limooo-status`、`limooo-blocklist-sync`、`limooo-d1-archive` 与 `image-watermark`；`status.limooo.cn` 与 `sink.limooo.cn` 是 Worker 自定义域名
6. **Cloudflare 规则**：自定义防火墙阶段为空（`limooo_blocklist` IP List 已就绪，等着规则来用）；缓存阶段把静态资源、旧图片路径与水印 Worker 响应缓存一年，两条 HTML 页面缓存规则处于停用状态；动态重定向阶段为空，`ops/waf/rules.snapshot.json` 保留历史 WAF 规则集以便重建
7. **冒烟检查**：`https://limooo.cn/_health` → 200，`https://limooo.cn/?challenge=1` → 403，`https://docs.limooo.cn/` 与 `https://status.limooo.cn/` → 200

门禁在每个主机上都原地渲染，门禁页与日志显示真实访客 IP，Access 仍是唯一的身份来源。
## 许可证

[GNU AGPL v3.0](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE.md)|[GNU AGPL v3.0-简体中文](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_zh_CN.md)|[GNU AGPL v3.0-日本語](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ja_JP.md)|[GNU AGPL v3.0-한국어](https://github.com/Limooooo-Studio/Limooo-Website/blob/main/LICENSE_ko_KR.md)
