/**
 * Limooo - serverless personal website and admin system
 *
 * Copyright (C) 2026 Limooo <https://limooo.cn/>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 每日 UTC 00:00 将前一天的分析数据写入私有 R2。
 *
 * 这里只归档可重建的分析明细，不删除 D1，也不搬运 Apple ID、会话或封禁表。
 * 对象键按日期固定，重复执行会幂等覆盖同一天的归档对象。
 */

interface D1Result<T> {
  results: T[];
  success: boolean;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(sql: string): D1Statement;
}

interface R2Object {
  key: string;
}

interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array> | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string } },
  ): Promise<R2Object | null>;
}

interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
}

type TableSpec = {
  name: string;
  sql: string;
};

const TABLES: TableSpec[] = [
  {
    name: "visitor_rollups",
    sql: `SELECT bucket_hour, ip_hash, country, status, page_slug, requests, last_ts
          FROM visitor_rollups
          WHERE bucket_hour >= ? AND bucket_hour < ?
          ORDER BY bucket_hour, ip_hash, country, status, page_slug`,
  },
  {
    name: "visitors_v2",
    sql: `SELECT id, ip_hash, country, status, ts, page_slug
          FROM visitors_v2
          WHERE ts >= ? AND ts < ?
          ORDER BY ts, id`,
  },
  {
    name: "ray_log_v2",
    sql: `SELECT ray, ts, host, normalized_path, method, status, duration_ms,
                 ip_hash, country, ua_family
          FROM ray_log_v2
          WHERE ts >= ? AND ts < ?
          ORDER BY ts, ray`,
  },
  {
    name: "events",
    sql: `SELECT id, event, ts, request_id, host, path, method, status, outcome,
                 ip_hash, country, duration_ms, message, account_id, actor_sub
          FROM events
          WHERE ts >= ? AND ts < ?
          ORDER BY ts, id`,
  },
];

function utcDateParts(epochSeconds: number): { day: string; start: number; end: number } {
  const date = new Date(epochSeconds * 1000);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "_");
  const next = new Date(date.getTime() + 86400 * 1000);
  return { day, start: epochSeconds, end: Math.floor(next.getTime() / 1000) };
}

function previousUtcDay(now = new Date()): { day: string; start: number; end: number } {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  return utcDateParts(todayStart - 86400);
}

async function gzipJsonl(rows: unknown[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const source = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const stream = new Blob([encoder.encode(source)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function archiveTable(env: Env, table: TableSpec, day: { day: string; start: number; end: number }): Promise<number> {
  // visitor_rollups 用 bucket_hour，其余分析表使用 ts；两者都是 UTC epoch 秒。
  const rows = await env.DB.prepare(table.sql).bind(day.start, day.end).all();
  const payload = await gzipJsonl(rows.results ?? []);
  await env.ARCHIVE.put(`analytics/${day.day}/${table.name}.jsonl.gz`, payload, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
  });
  return rows.results?.length ?? 0;
}

export async function archivePreviousDay(env: Env, now = new Date()): Promise<Record<string, number>> {
  const day = previousUtcDay(now);
  const counts: Record<string, number> = {};
  for (const table of TABLES) counts[table.name] = await archiveTable(env, table, day);
  console.log(JSON.stringify({ event: "d1_archive", day: day.day, counts }));
  return counts;
}

export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(archivePreviousDay(env));
  },

  async fetch(_request: Request): Promise<Response> {
    // 归档只允许由 Cloudflare Cron 触发，避免公开 URL 被反复调用造成 D1 读取。
    return new Response("Not Found", { status: 404 });
  },
};
