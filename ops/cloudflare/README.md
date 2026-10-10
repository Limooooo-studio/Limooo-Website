# Limooo Cloudflare 资源清单

本目录是 Limooo 云资源的声明式描述，供部署、回滚和外部审计使用。所有真实
token、secret 与可复现的 ID **不写在这里**，统一从以下来源读取：

| 资源 | 名称 / 类型 | 值来源 | 说明 |
| --- | --- | --- | --- |
| Pages 项目 | `limooo` | 配置文件 `site/wrangler.toml` | 构建输出目录 `public`，托管 `limooo.cn` 与子域 |
| Pages Functions | `functions/**` | Git 仓库代码 | 门禁、登录、Apple Account、访客统计、Ray 查询 |
| D1 数据库 | `DB` binding | `site/wrangler.toml` 的 `database_id` | Pages 与 `sync-worker` 共用 |
| D1 迁移 | `ops/migrations/*.sql` | Git 仓库代码 | 执行入口 `ops/migrate_d1.sh` |
| Worker：探针/状态页 | `limooo-status` | `ops/status-worker/wrangler.toml` | 每分钟探针 + down 后 10 秒复查；`status.limooo.cn` 状态页；每日 03:47 D1 保留清理 |
| Worker：封禁同步 | `limooo-blocklist-sync` | `ops/sync-worker/wrangler.toml` | 每日 03:30，D1 active 行 → Cloudflare IP List |
| Worker：图片水印 | `image-watermark` | `ops/image-watermark/wrangler.toml` | `image.limooo.cn/*` 归一化代理，/portfolio/* 永远返水印（A2） |
| R2 私有桶（原图备份） | `limooo-originals` | `ops/upload_originals.sh` | A2 后作品集原图只存本地 + 私有 R2，不随 Pages 发布 |
| WAF IP List | `limooo_blocklist` | `ops/sync-worker` | Cloudflare List，供 WAF 规则引用 |
| DNS 区域 | `limooo.cn` | Cloudflare 控制台 | CNAME 到 `limooo.pages.dev`，详见 AGENTS.md |
| WAF 规则 | 自定义规则 | Cloudflare 控制台 | `ip.src in $limooo_blocklist`、低风险 `js_challenge` |
| Cache Rules | `Limooo public cache` | Cloudflare API / 控制台 | 公开 HTML 缓存 300 秒；`/static` 及 favicon 缓存 1 年 |

## Pages 环境变量（只列键名，不列值）

在 Cloudflare Pages 项目设置的 `Environment variables → Encrypt (Secret)` 配置：

- `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`
- `GATE_HMAC_KEY`、`SESSION_HMAC_KEY`
- `ACCESS_TEAM_DOMAIN`、`ACCESS_ADMIN_AUDS`、`ACCESS_VIEWER_AUDS`
- `APPLE_ACCOUNT_ENCRYPTION_KEY`、`VISITOR_IP_KEY`
- `OBSERVABILITY_HMAC_KEY`

本地开发复制 `.dev.vars.example`；生产值只从本机 `secrets/webauthn.env` 与 Pages
项目 Secret 读取（不入库、不回显），已无服务器端凭据来源。

## 迁移与回滚

1. 变更前备份 D1：`wrangler d1 export <database> --remote`（登记到
   `docs/parallel-actions.md`）。
2. 预览：`bash ops/migrate_d1.sh --dry-run`。
3. 执行：`bash ops/migrate_d1.sh --remote`。
4. 回滚：用备份恢复后，重新执行 `migrate_d1.sh --remote`；不会自动回退
   已应用的代码版本，必须与 Git 提交配合。

## 部署顺序

```bash
# 1. 构建并校验（不部署）
bash ops/pages_deploy.sh --build-only

# 2. 预览迁移与 Cloudflare 命令
bash ops/pages_deploy.sh --dry-run
bash ops/workers_deploy.sh --dry-run

# 3. 实际部署（需凭据，按 docs/parallel-actions.md 预约）
bash ops/pages_deploy.sh
bash ops/workers_deploy.sh
```

## Cache Rules

已在 `limooo.cn` 区域创建 `Limooo public cache`。**2026-09-26 起两条 HTML
缓存规则已停用**（`Cache public HTML for returning visitors`、
`Cache images gallery page for returning visitors`，`enabled=false`），原因：
它们的 `cache_key` 为空，边缘只按 URL 缓存，而公开页语言由
`user_lang_preference` cookie 决定 → 第一个访客的语言会被发给所有同 URL 访客，
切语言后再访问仍拿到旧语言。免费版**不支持**自定义 cache key
（`custom_key` 报 `not entitled to use the custom cache key override`），
无法把 cookie 加进 key，故停用规则，改由 Worker 的 Cache API 按
`lang` 分桶缓存（`functions/_middleware.ts` 的 `cachedPageAsset`），
响应头 `Vary: Accept-Language, Cookie`。页面 TTL 仍是 300 秒，行为不变。

保留的历史记录：

- 公开 HTML：曾匹配 `limooo.cn`、`services.limooo.cn`、`contact.limooo.cn`
  的 `/`、`/services`、`/contact` 页面，且请求带 `user_lang_preference`
  cookie；Edge/Browser TTL 300 秒。
- 静态资源：匹配上述主域及 `images.limooo.cn` 的
  `/static/*`，以及主站 favicon 与 `limooo-xtext.svg`；Edge/Browser TTL
  1 年。

> A2 之后 `/static/portfolio/**` 不再被当作公开图片（原图已移除，只保留
> `/static/wm/portfolio/**` 水印与 `/static/portfolio/thumbs/**` 缩略图），
> 但旧版本曾以 `immutable`（1 年）缓存过干净原图。切换到 A2 后需
> **手动清理 `/static/portfolio/*` 的 Cloudflare 边缘缓存**，否则边缘可能
> 继续返回旧的干净原图。

规则通过 Cloudflare Rulesets API 的 `http_request_cache_settings` phase
管理，token 权限需求见 Cloudflare Cache Rules 文档。修改或删除请到
Cloudflare 控制台 `Rules → Cache Rules` 操作，避免与当前 Pages 代码
冲突。

## D1 保留与清理

- `ray_log_v2` 保留 7 天，`visitors_v2` 保留 30 天，`events` 保留 90 天。
- `visitors_daily` 为永久聚合表，由 `ops/prune_d1.py --mode aggregate --apply` 写入。
- 生产定时任务全部是 Worker Cron Trigger：状态探针每分钟、清理每天 03:47
  （`ops/status-worker`），封禁同步每天 03:30（`ops/sync-worker`）。
  已无 VPS crontab，`install_retention_cron.sh` 随 VPS 一并删除。

## 待办 / 外部确认

- 用户已决定不恢复历史 1255 条快照；备份仅作归档，不导入 D1 / CF List。
- 登录已改为 Cloudflare Access；authentik / Uptime Kuma 相关条目随 VPS 退租作废。
- WAF 自定义规则、DNS record 的变更应通过 Cloudflare API 或控制台执行，
  本文件只负责让这些状态可追溯。
- A2 图片归属已落地：原图私有（`limooo-originals`），公开只发水印变体与缩略图。
