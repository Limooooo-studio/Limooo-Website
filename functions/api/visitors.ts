/**
 * GET /api/visitors
 *
 * 需要 admin 会话，D1 前向统计。为保护隐私，接口不返回完整 IP，只返回
 * ip_hash；要看某个访客的真实 IP，走同一目录下的单行端点
 * `GET /api/visitors/<ip_hash>/ip`（点击访客行时才会解密那一条）。
 * 前端状态筛选已本地化，因此主前端只调用不带 status 参数的端点；
 * `?status=<3位数字>` 保留给深链和外部调用。
 *
 * 查询范围：新 visitor_rollups 与迁移前 visitors_v2 明细共同统计最近 30 天。
 * rollups 把同一小时/IP/页面/状态压成一行，但 requests 仍是精确请求数。
 */

import { queryAll } from "../_lib/d1";
import { requireAdminSession } from "../_lib/session";
import type { Env } from "../_lib/env";

const VISITOR_WINDOW_DAYS = 30;
const VISITOR_WINDOW_SECONDS = VISITOR_WINDOW_DAYS * 24 * 60 * 60;
const MAX_VISITOR_MARKERS = 500;

/**
 * 查询结果缓存 300 s（与 AGENTS.md「面向 D1 的页面轮询不得快于 5 分钟」同口径）。
 *
 * 前端按 600 s 轮询，理论上每 5 分钟就会回源一次，300 s 的缓存只吸收同一窗口
 * 内的重复请求（多标签页、手动刷新、外部抓取）。代价是管理员最坏多等 5 分钟
 * 才看到最新访客——这是用户已确认接受的取舍，换的是不再有单页打满每日读额度的风险。
 */
const VISITOR_CACHE_CONTROL = "public, max-age=300";
const VISITOR_CACHE_SECONDS = 300;

type VisitorCacheLike = {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
};

interface StatsRow {
  ips: number;
  requests: number;
  countries: number;
  status_series: string | null;
}

interface MarkerRow {
  ip_hash: string;
  country: string;
  status: number;
  n: number;
  /** D1 取回的整数（visitors_v2.ts / visitor_rollups.last_ts 都是 INTEGER）。 */
  last_ts: number;
}

interface MarkerAccumulator {
  country: string;
  count: number;
  /** 最近一次访问的 Unix 秒；返回给前端前再转成带 Z 的 ISO 时间戳。 */
  last_time: number;
  statuses: Record<string, number>;
}

function parseStatusSeries(value: string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value) return counts;
  for (const part of value.split(",")) {
    const sep = part.lastIndexOf(":");
    if (sep <= 0) continue;
    const code = part.slice(0, sep).trim();
    const n = Number(part.slice(sep + 1));
    if (code && Number.isFinite(n)) {
      counts[code] = (counts[code] ?? 0) + n;
    }
  }
  return counts;
}

function buildMarkers(rows: MarkerRow[]): Array<{
  ip: null;
  ip_hash: string;
  country: string;
  city: string;
  latitude: null;
  longitude: null;
  hosts: unknown[];
  count: number;
  /** UTC ISO8601（`2026-01-02T00:00:00Z`）；展示时由前端换算到访问者（浏览器）时区。 */
  last_time: string;
  statuses: Record<string, number>;
}> {
  const byHash = new Map<string, MarkerAccumulator>();
  for (const row of rows) {
    let acc = byHash.get(row.ip_hash);
    if (!acc) {
      acc = {
        country: row.country,
        count: 0,
        last_time: row.last_ts,
        statuses: {},
      };
      byHash.set(row.ip_hash, acc);
    }
    acc.count += row.n;
    // 国家必须跟着**最近一次访问**走：只更新 last_time 会让展示的国家取决于
    // D1 返回的行顺序（同一个 ip_hash 有多种 status、各自 last_ts 不同时更明显）。
    if (row.last_ts > acc.last_time) {
      acc.last_time = row.last_ts;
      acc.country = row.country;
    }
    const key = String(row.status);
    acc.statuses[key] = (acc.statuses[key] ?? 0) + row.n;
  }

  return Array.from(byHash.entries(), ([ip_hash, acc]) => ({
    ip: null,
    ip_hash,
    country: acc.country,
    city: "",
    latitude: null,
    longitude: null,
    hosts: [],
    count: acc.count,
    last_time: new Date(acc.last_time * 1000).toISOString(),
    statuses: acc.statuses,
  }));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdminSession(context.env, context.request, "无权限");
  if (auth instanceof Response) return auth;

  const url = new URL(context.request.url);
  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && !/^\d{3}$/.test(statusParam)) {
    return Response.json(
      { error: "无效的 status 参数，应为三位数字" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const statusNum = statusParam === null ? null : Number(statusParam);

  // ── 进程内缓存（300 s）────────────────────────────────────────────────
  // 一次查询实测 13.1 万行读取（见下方 SQL 注释）。管理页整天开着轮询 600 s
  // 也有 ≈ 144 次/天 → 直接逼近 5,000,000 行/天的免费版上限，正是 2026-09-17
  // 事故的形态。同一请求 URL（含 status 过滤）在 5 分钟内结果完全相同，缓存
  // 只是把重复的同一份数据挡住，不改变口径。
  //
  // 鉴权在缓存之前，缓存键不含身份：这不是权限缓存，未通过 admin 校验的请求
  // 根本走不到这里，也不会被写进缓存。
  const cacheKeyUrl = new URL(url.toString());
  cacheKeyUrl.searchParams.set("__cache", String(VISITOR_CACHE_SECONDS));
  const cache = typeof caches !== "undefined"
    ? (caches as unknown as { default?: VisitorCacheLike }).default
    : undefined;
  if (cache) {
    const hit = await cache.match(new Request(cacheKeyUrl));
    if (hit) return hit;
  }

  const cutoff = Math.floor(Date.now() / 1000) - VISITOR_WINDOW_SECONDS;

  // 查询 1：全局统计 + 全量状态分布。用同一 30 天窗口，避免状态分布与
  // 顶部统计口径不一致。
  //
  // 性能约束（D1 免费版 5M 行/天）：四个指标合并成「一次外层聚合 + 一次状态
  // 分布」两趟扫描。旧写法把 COUNT(DISTINCT)/SUM/COUNT(DISTINCT) 各写成一个
  // 子查询，等于把 30 天窗口扫了 5 遍——这正是 2026-09 撞到每日读取上限的主因。
  const statsRows = await queryAll<StatsRow>(
    context.env.DB,
    `WITH scoped AS (
        SELECT ip_hash, country, status, ts, 1 AS requests
        FROM visitors_v2
        WHERE ts >= ?
        UNION ALL
        SELECT ip_hash, country, status, last_ts AS ts, requests
        FROM visitor_rollups
        WHERE last_ts >= ?
     )
     SELECT
       COUNT(DISTINCT ip_hash) AS ips,
       COALESCE(SUM(requests), 0) AS requests,
       COUNT(DISTINCT country) AS countries,
       (SELECT GROUP_CONCAT(status || ':' || n, ',') FROM (
          SELECT status, SUM(requests) AS n FROM scoped GROUP BY status ORDER BY status
       )) AS status_series
     FROM scoped`,
    cutoff,
    cutoff,
  );

  // 查询 2：最近 500 个 IP 哈希的列表及每个 IP 的状态分布。
  // 先取 top 500，再按 ip_hash+status 分组，一次拿到构建 markers 所需的全部行。
  //
  // 带不带 status 过滤只差 `AND status = ?` 这一处，因此用插值拼一份 SQL；
  // statusFilter 由 statusNum 是否为空推导（非用户输入），与上面 `${MAX_VISITOR_MARKERS}`
  // 同一套写法，不引入注入面。
  //
  // 国家取**最近一次**访问的值。不能写 MAX(country)：那按字母序选，与
  // 「最近」无关（CN/CH 混合的访客会恒显示 CN）。同 IP 跨国是常态——
  // 代理/中转网段上 Cloudflare 在不同时间本就可能判出不同国家。
  // 实现要点（都拿线上 D1 实测过，别凭直觉改）：
  //   · top 已经带每 IP 的 last_ts，直接 JOIN 回 scoped 取那一行的国家，
  //     实测 13.1 万行读取；
  //   · 不要用相关子查询（SELECT s2.country ... ORDER BY ts DESC LIMIT 1）
  //     ——1370 万行；不要用 NOT EXISTS ——753 万行；不要用
  //     ROW_NUMBER() 全分区排序 ——17.5 万行。免费版上限 5M 行/天。
  const statusFilter = statusNum === null ? "" : " AND status = ?";
  const markerSql = `WITH scoped AS (
         SELECT ip_hash, country, status, ts, 1 AS requests
         FROM visitors_v2
         WHERE ts >= ?${statusFilter}
         UNION ALL
         SELECT ip_hash, country, status, last_ts AS ts, requests
         FROM visitor_rollups
         WHERE last_ts >= ?${statusFilter}
       ),
       top AS (
         SELECT ip_hash, MAX(ts) AS last_ts
         FROM scoped
         GROUP BY ip_hash
         ORDER BY last_ts DESC
         LIMIT ${MAX_VISITOR_MARKERS}
       ),
       latest AS (
         SELECT t.ip_hash, MAX(s.country) AS country
         FROM top t
         JOIN scoped s ON s.ip_hash = t.ip_hash AND s.ts = t.last_ts
         GROUP BY t.ip_hash
       )
       SELECT v.ip_hash, l.country, v.status,
              SUM(v.requests) AS n,
              MAX(v.ts) AS last_ts
       FROM scoped v
       JOIN top t ON t.ip_hash = v.ip_hash
       JOIN latest l ON l.ip_hash = v.ip_hash
       GROUP BY v.ip_hash, v.status
       ORDER BY MAX(v.ts) DESC, v.status`;

  const markerParams: unknown[] = statusNum === null
    ? [cutoff, cutoff]
    : [cutoff, statusNum, cutoff, statusNum];
  const markerRows = await queryAll<MarkerRow>(context.env.DB, markerSql, ...markerParams);

  const stats = statsRows[0] ?? { ips: 0, requests: 0, countries: 0, status_series: null };
  const statusCounts = parseStatusSeries(stats.status_series);

  const response = Response.json(
    {
      stats: { total_ips: stats.ips, total_requests: stats.requests, countries: stats.countries },
      status_counts: statusCounts,
      range_days: VISITOR_WINDOW_DAYS,
      max_markers: MAX_VISITOR_MARKERS,
      markers: buildMarkers(markerRows),
    },
    { headers: { "Cache-Control": VISITOR_CACHE_CONTROL } },
  );
  if (cache) {
    // put 失败不能让请求变 500（缓存只是优化）。
    try {
      await cache.put(new Request(cacheKeyUrl), response.clone());
    } catch {
      // 忽略：下次请求照常回源。
    }
  }
  return response;
};
