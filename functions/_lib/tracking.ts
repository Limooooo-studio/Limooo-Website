/**
 * Limooo 访客 / Ray 埋点（仅最小字段）。
 *
 * 隐私约定：
 * - visitors_v2 / ray_log_v2 不保存完整 IP、UA 或 query；
 * - IP 使用独立 OBSERVABILITY_HMAC_KEY 的 HMAC 前 16 位；
 * - visitor_rollups 额外存一份 **加密** 的 IP（VISITOR_IP_KEY，见 _lib/visitor-ip.ts），
 *   只在 admin 点击某一行时单条解密；列表接口永远不返回它；
 * - 埋点失败只输出控制台，不阻塞业务、不递归写错误事件。
 */

import { execute, executeBatch } from "./d1";
import type { Env } from "./env";
import { ipHash } from "./logging";
import { encryptVisitorIp } from "./visitor-ip";
import { GATE_TRUST } from "../_data/gateTrust";
import { IMAGES_HOSTNAME, REDIRECT_HOSTNAME } from "./config";
import { clientCountryForLogs, clientIpForLogs } from "./routing";

let trackingSchemaReady = false;
/** 上次尝试建表的时间戳（毫秒）；见 ensureTrackingSchema 与 docs/22 W9-19。 */
let trackingSchemaAttemptAt = 0;
const SCHEMA_RETRY_COOLDOWN_MS = 60_000;

const TRACKING_DDL = [
  `CREATE TABLE IF NOT EXISTS visitor_rollups (
    bucket_hour INTEGER NOT NULL,
    ip_hash     TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    page_slug   TEXT NOT NULL DEFAULT '',
    requests    INTEGER NOT NULL DEFAULT 1,
    last_ts     INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_enc      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (bucket_hour, ip_hash, country, status, page_slug)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_visitor_rollups_ip_hash ON visitor_rollups (ip_hash, last_ts)",
  `CREATE TABLE IF NOT EXISTS visitors_v2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash     TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL DEFAULT '',
    status      INTEGER NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    page_slug   TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_ts ON visitors_v2 (ts)",
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_ip_hash_ts ON visitors_v2 (ip_hash, ts)",
  "CREATE INDEX IF NOT EXISTS idx_visitors_v2_page_slug_ts ON visitors_v2 (page_slug, ts)",
  `CREATE TABLE IF NOT EXISTS ray_log_v2 (
    ray             TEXT PRIMARY KEY,
    ts              INTEGER NOT NULL DEFAULT (unixepoch()),
    host            TEXT NOT NULL DEFAULT '',
    normalized_path TEXT NOT NULL DEFAULT '',
    method          TEXT NOT NULL DEFAULT '',
    status          INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    ip_hash         TEXT NOT NULL DEFAULT '',
    country         TEXT NOT NULL DEFAULT '',
    ua_family       TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ray_log_v2_ts ON ray_log_v2 (ts)",
];

export function isTrustedCrawler(request: Request): boolean {
  const cf = (request as Request & { cf?: { botManagement?: { verifiedBot?: boolean } } }).cf;
  if (GATE_TRUST.verified_bot !== true) return false;
  return cf?.botManagement?.verifiedBot === true;
}

/** 去掉参数后的规范化路径，限制长度，避免超长/恶意路径拖垮 D1。 */
export function normalizePath(pathname: string): string {
  return pathname.split("?")[0].slice(0, 2048);
}

/** 访问路径 → 便于聚合的页面 slug。 */
export function pageSlug(pathname: string): string {
  const p = normalizePath(pathname).replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/index.html") return "home";
  if (p.startsWith("/services")) return "services";
  if (p.startsWith("/contact")) return "contact";
  if (p.startsWith("/visitor")) return "visitor";
  if (p.startsWith("/account")) return "apple-account";
  if (p.startsWith("/login")) return "login";
  if (p.startsWith("/logout")) return "logout";
  const first = p.split("/").filter(Boolean)[0];
  return first || "root";
}

/** UA 白名单枚举：只保留有限分类，不落原始 UA。 */
export function uaFamily(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "";
  const bots: Array<[RegExp, string]> = [
    [/googlebot/, "googlebot"],
    [/bingbot/, "bingbot"],
    [/baiduspider/, "baiduspider"],
    [/yandex/, "yandexbot"],
    [/applebot/, "applebot"],
    [/gptbot|chatgpt-|oai-searchbot/, "ai-bot"],
    [/claudebot|anthropic-ai|claude-web/, "ai-bot"],
    [/perplexitybot|amazonbot|ccbot|diffbot/, "ai-bot"],
    [/uptimerobot|pingdom|gtmetrix|statuscake|datadog|zabbix/, "monitor"],
  ];
  for (const [re, name] of bots) if (re.test(ua)) return name;
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("chrome")) return "chrome";
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("safari")) return "safari";
  if (ua.includes("mobile")) return "mobile";
  return "other";
}

/** 访客统计只记录真实用户页面 GET；爬虫/静态/API/门禁/图片/跳转均不记。 */
export function shouldTrackVisit(request: Request, url: URL): boolean {
  if (request.method !== "GET") return false;
  if (isTrustedCrawler(request)) return false;
  if (url.hostname === IMAGES_HOSTNAME || url.hostname === REDIRECT_HOSTNAME) return false;
  const p = url.pathname;
  if (
    p.startsWith("/api/") ||
    p === "/_health" ||
    p.startsWith("/static/") ||
    p.startsWith("/__gate") ||
    p.startsWith("/favicon") ||
    p === "/Limooo-xtext.svg"
  ) {
    return false;
  }
  if (isGateEndpointPath(p)) return false;
  return !/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(p);
}

/** `/__gate/...`（旧前缀，308 中转）与 `/gate/...`（规范化路径）归一到同一形式。 */
function normalizeGatePath(pathname: string): string {
  return pathname.startsWith("/__gate")
    ? `/gate${pathname.slice("/__gate".length)}`
    : pathname;
}

/**
 * 门禁页自身的**接口**路径：前端加载门禁页时依次调用 `/gate/config`（补 sitekey、
 * 文案、root domain）与 `/gate/diag`（显示可反查的 Ray ID），验证表单 POST `/gate/verify`。
 *
 * 这些请求都属于门禁页自己，不是访客在浏览页面，**访问统计一律不记**。
 *
 * 历史坑：排除名单里只写了旧前缀 `/__gate`，前端实际打的是 `/gate/config` 与
 * `/gate/diag`（`/__gate` 只是 308 中转）。于是未验证访客每看一次门禁页就换 1–2 条
 * D1 写入，任何人（含扫描器）都能匿名放大写额度——正是 2026-09-17 事故的形态。
 */
function isGateEndpointPath(pathname: string): boolean {
  const p = normalizeGatePath(pathname);
  return p === "/gate/config" || p === "/gate/verify" || p === "/gate/diag";
}

/**
 * 门禁页里**唯一允许记 Ray** 的路径。
 *
 * 用显式白名单而不是「从黑名单里挑几个排除」：以后再加 `/gate/*` 接口时，
 * 忘记登记只会漏记（可接受），不会像黑名单那样悄悄开始按请求写库。
 * 必须保留它的原因：门禁页展示的 Ray ID 要能在 Ray 日志里反查。
 */
function isTraceableGatePath(pathname: string): boolean {
  const p = normalizeGatePath(pathname);
  return p === "/gate/diag";
}

/** Ray 记录只保留页面和少量入口；静态、全部 API、门禁接口、图片/跳转子域不记。
 *  例外：`/gate/diag`（auth 页展示的 Ray ID 必须可反查）。 */
export function shouldTrackRay(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") return false;
  if (url.hostname === IMAGES_HOSTNAME || url.hostname === REDIRECT_HOSTNAME) return false;
  const p = url.pathname;
  if (isTraceableGatePath(p)) return true;
  if (
    p.startsWith("/api/") ||
    p === "/_health" ||
    p.startsWith("/static/")
  ) {
    return false;
  }
  if (isGateEndpointPath(p)) return false;
  if (p.startsWith("/favicon") || p === "/Limooo-xtext.svg") return false;
  if (/\.(png|webp|jpg|jpeg|gif|ico|svg|css|js|json|webmanifest|txt|xml)$/i.test(p)) return false;
  return true;
}

/**
 * 每个 isolate 首次写入前幂等建表（docs/22 W9-19）。
 *
 * 与 `logging.ts` 的 ensureEventSchema 同一策略：记住「已尝试」+ 每分钟最多重试
 * 一次（D1 故障期间不能让每个请求都先打一批必然失败的 DDL），并把多条 DDL 压成
 * 一次 `db.batch` 往返；只有 `db.batch` 不存在时才退回逐句执行。
 */
async function ensureTrackingSchema(env: Env): Promise<void> {
  if (trackingSchemaReady || !env.DB) return;
  const now = Date.now();
  if (now - trackingSchemaAttemptAt < SCHEMA_RETRY_COOLDOWN_MS) return;
  trackingSchemaAttemptAt = now;
  try {
    const db = env.DB;
    if (db.batch) {
      if (await executeBatch(db, TRACKING_DDL.map((sql) => db.prepare(sql)))) {
        trackingSchemaReady = true;
      }
      return;
    }
    for (const sql of TRACKING_DDL) {
      if (!(await execute(env.DB, sql))) return;
    }
    trackingSchemaReady = true;
  } catch {
    // 冷却窗口过后重试；埋点失败不影响业务。
  }
}

/** 响应完成后记录访客；同一小时/IP/页面/状态聚合为一行，计数仍保持精确。 */
export async function recordVisit(env: Env, request: Request, status: number): Promise<void> {
  if (!env.DB) return;
  const url = new URL(request.url);
  const ip = clientIpForLogs(request);
  try {
    await ensureTrackingSchema(env);
    await execute(
      env.DB,
      `INSERT INTO visitor_rollups
         (bucket_hour, ip_hash, country, status, page_slug, requests, last_ts, ip_enc)
       VALUES ((unixepoch() / 3600) * 3600, ?, ?, ?, ?, 1, unixepoch(), ?)
       ON CONFLICT(bucket_hour, ip_hash, country, status, page_slug) DO UPDATE SET
         requests = visitor_rollups.requests + 1,
         last_ts = excluded.last_ts,
         -- 同 IP 每次加密的 IV 不同，只在原本为空（当时还没配密钥）时补写。
         ip_enc = CASE
           WHEN visitor_rollups.ip_enc = '' THEN excluded.ip_enc
           ELSE visitor_rollups.ip_enc
         END`,
      await ipHash(ip, env),
      clientCountryForLogs(request),
      status,
      pageSlug(url.pathname),
      await encryptVisitorIp(ip, env),
    );
  } catch (error) {
    // 不递归写错误事件，仅保留 Pages 控制台。
    console.error(JSON.stringify({ event: "visit_record_error", message: String(error) }));
  }
}

/** 响应完成后记录 Ray 请求；只写 ray、时间、host、规范路径、方法、状态、耗时、ip_hash、country、ua_family。 */
export async function recordRay(
  env: Env,
  request: Request,
  status: number,
  durationMs: number,
): Promise<void> {
  if (!env.DB) return;
  const url = new URL(request.url);
  const ray = request.headers.get("CF-Ray") ?? "";
  if (!ray) return;
  try {
    await ensureTrackingSchema(env);
    await execute(
      env.DB,
      `INSERT OR IGNORE INTO ray_log_v2
        (ray, ts, host, normalized_path, method, status, duration_ms, ip_hash, country, ua_family)
       VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      ray,
      url.hostname,
      normalizePath(url.pathname),
      request.method,
      status,
      Math.max(0, Math.round(durationMs)),
      await ipHash(clientIpForLogs(request), env),
      clientCountryForLogs(request),
      uaFamily(request.headers.get("User-Agent") ?? ""),
    );
  } catch (error) {
    // fail-open + 不递归写错误事件。
    console.error(JSON.stringify({ event: "ray_record_error", message: String(error) }));
  }
}
