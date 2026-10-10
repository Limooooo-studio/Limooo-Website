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
 *
 * 失败可见性（2026-10-11 补，与 ops/sync-worker 同一套）：此前 scheduled() 只写
 * `ctx.waitUntil(archivePreviousDay(env))`，协程 rejection 被 waitUntil 静默吞掉，
 * 归档连续失败也只在 cron 面板上显示「已运行」；fetch 又恒 404，没有任何健康入口。
 * 现在：
 *   1. 每次运行在 D1 worker_runs 落一行（job='d1_archive'），失败带 error；
 *   2. scheduled() 显式 await + try/catch，失败打结构化单行 JSON 到 Workers 日志；
 *   3. GET /?health=1 只报健康状态（不触发归档），返回 { ok, job, lastRun }。
 * 归档逻辑本身（TABLES、R2 键、gzip 内容、day 的算法）一行未改。
 *
 * 第二个 stage（2026-10-11 补，灾备快照）：同一个 cron 里再跑一次配置与 schema
 * 快照（R2 `backup/YYYY_MM_DD/`，job='config_backup'，实现在 ./config-backup.ts）。
 * 两个 stage 是**并列**的：归档先跑，快照后跑，各自 try/catch，互不牵连 ——
 * 快照失败绝不能让归档失败，反之亦然。
 */

import {
  insertRun,
  lastRun,
  runStartedAt,
  updateRun,
  type RunRow,
} from "../../sync-worker/src/runlog";
import {
  CONFIG_JOB,
  runConfigBackup,
  type D1Database,
  type R2Bucket,
} from "./config-backup";
import { gzipJsonl } from "./jsonl";
import { logRun } from "./log";

interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  /** 与 limooo-blocklist-sync 共用的健康端点共享密钥；未配置时 HTTP 一律 fail-closed。 */
  SYNC_TOKEN?: string;
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

/** 运行记录里的任务名：与 ops/migrations/018_worker_runs.sql 的 job 列取值一致。 */
export const JOB = "d1_archive";

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

async function archiveTable(env: Env, table: TableSpec, day: { day: string; start: number; end: number }): Promise<number> {
  // visitor_rollups 用 bucket_hour，其余分析表使用 ts；两者都是 UTC epoch 秒。
  const rows = await env.DB.prepare(table.sql).bind(day.start, day.end).all();
  // gzipJsonl 与配置快照共用（见 ./jsonl.ts）：两条路径的字节格式必须一模一样。
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

/**
 * scheduled / fetch 共用的入口：归档前一天，并把这次运行写成 worker_runs 的一行。
 *
 * 归档本身抛错时先记 outcome='failed'（带 error）再继续往外抛 —— 「抛了」与
 * 「记了」不能分家。运行记录写入失败只 console.error，绝不影响归档本身。
 */
export async function runArchive(
  env: Env,
  now = new Date(),
): Promise<{ counts: Record<string, number>; runId: number | null }> {
  const startedAt = runStartedAt();
  const runId = await insertRun(env.DB, JOB, startedAt);
  logRun(JOB, { outcome: "started" });
  try {
    const counts = await archivePreviousDay(env, now);
    await updateRun(env.DB, runId, {
      finishedAt: runStartedAt(),
      outcome: "ok",
      // added/removed 是同步语义的列，归档不用；total 记进日志，明细在成功那行的 counts。
      added: Object.values(counts).reduce((sum, n) => sum + n, 0),
      // 归档没有演练模式：写了就是写了。
      dryRun: false,
    });
    logRun(JOB, { outcome: "ok", counts, duration_ms: runStartedAt() - startedAt });
    return { counts, runId };
  } catch (error) {
    await updateRun(env.DB, runId, {
      finishedAt: runStartedAt(),
      outcome: "failed",
      error: String(error),
    });
    logRun(JOB, { outcome: "failed", error: String(error), duration_ms: runStartedAt() - startedAt });
    throw error;
  }
}

/**
 * 健康端点的鉴权：比对 Authorization: Bearer <SYNC_TOKEN>。
 *
 * 该 Worker 只在 *.workers.dev 上，workers.dev 不属于本账户，无法用 zone 级
 * mTLS/Client Certificate 保护，所以沿用 limooo-blocklist-sync 的共享密钥。密钥
 * 未配置时 fail-closed（拒绝所有 HTTP 调用）——「忘了设 secret 就等于开放」是
 * 这里唯一不能接受的失败方向。cron 走内部调用，不经过这里。
 */
export function authorized(request: Request, env: Env): boolean {
  const expected = (env.SYNC_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length).trim();
  if (!provided || provided.length !== expected.length) return false;
  // 长度相等时逐字符比较，避免提前返回泄露前缀信息。
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** 只报健康状态（不触发归档）：最近一次运行记录 + 表不可用时的原因。 */
export async function health(
  env: Env,
): Promise<{ ok: boolean; job: string; lastRun: RunRow | null; error?: string }> {
  try {
    return { ok: true, job: JOB, lastRun: await lastRun(env.DB, JOB) };
  } catch (error) {
    // 读不到运行记录不等于归档失败，如实区分：ok 仍为真，附上读失败原因。
    return { ok: true, job: JOB, lastRun: null, error: String(error) };
  }
}

export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    // 必须显式 await 进一个 try/catch：`ctx.waitUntil(archivePreviousDay(env))`
    // 会把 rejection 吞掉，归档连续失败也只在 cron 面板上显示成功。
    const work = (async () => {
      // stage 1：分析明细归档（analytics/YYYY_MM_DD/，按数据所属的 UTC 日）。
      try {
        const { counts } = await runArchive(env);
        logRun(JOB, {
          outcome: "scheduled_ok",
          archived: Object.values(counts).reduce((sum, n) => sum + n, 0),
        });
      } catch (error) {
        logRun(JOB, { outcome: "failed", stage: "scheduled", error: String(error) });
      }
      // stage 2：配置与 schema 快照（backup/YYYY_MM_DD/，按快照产生的 UTC 日）。
      // 独立的 try/catch：stage 1 失败不影响 stage 2，stage 2 失败也绝不能让
      // 已经写进 R2 的归档变成一次「失败运行」—— 两个 job 的运行记录各自成行。
      try {
        await runConfigBackup(env);
      } catch (error) {
        logRun(CONFIG_JOB, { outcome: "failed", stage: "scheduled", error: String(error) });
      }
    })();
    /**
     * 同时递给 waitUntil 与本地 await：前者保证 isolate 在响应后仍把活干完，后者
     * 保证这次的 promise 被显式观察过 —— 这正是修掉「rejection 被静默吞掉」的关键。
     */
    ctx.waitUntil(work);
    await work;
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // 归档只允许由 Cloudflare Cron 触发，避免公开 URL 被反复调用造成 D1 读取；
    // HTTP 面只保留只读健康端点，且必须先过鉴权。
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!authorized(request, env)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("health") === "1") {
      return Response.json(await health(env));
    }
    // 除健康端点外不暴露任何其它形态，返回 404 而不是触发归档。
    return new Response("Not Found", { status: 404 });
  },
};
