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
 * D1 保留任务（从 VPS 的 ops/prune_d1.py 迁移，docs/17 阶段 6）
 *
 * VPS 退役后原 cron 不复存在，若不迁移，D1 会无限增长直至撞上单库上限。
 *
 * **本文件是保留策略的 owner**（docs/22 W7-8）：它是被 cron 调度的那一份，
 * `ops/readme_facts.py` 与 `ops/prune_d1.py` 都从这里读窗口；prune_d1.py 在导入时
 * 与本文件逐条比对，不一致直接报错，所以两份策略不可能再各自漂移。
 *
 * 注意：prune_d1.py 还有「把访客明细聚合进 visitors_daily」的部分（手动入口），
 * 本文件只做**每日清理**（防爆库的关键路径）。
 */

export const DAY_SECONDS = 86_400;

/** 表 → 保留秒数（owner；ops/prune_d1.py 从本文件读同一份值）。 */
export const BUCKETS: Record<string, number> = {
  ray_log_v2: 7 * DAY_SECONDS,
  visitors_v2: 30 * DAY_SECONDS,
  visitor_rollups: 30 * DAY_SECONDS,
  events: 90 * DAY_SECONDS,
  // 每分钟 3 条心跳 → 不清理就会无限增长，并拖慢状态页/排障查询。
  heartbeats: 30 * DAY_SECONDS,
  // 按天在线率汇总只保留 90 天（状态页最多看 7 天）。
  probe_uptime_daily: 90 * DAY_SECONDS,
  // 每次登录写一行（`functions/login.ts` 的 createAuthSession），此前没有任何
  // 清理路径，只增不减。窗口取 60 天：必须**长于** session_ttl_seconds（30 天，
  // 见 config-contract.json），否则会在会话仍有签名有效期时把行删掉（登录态被踢）。
  auth_sessions: 60 * DAY_SECONDS,
};

/** 非默认时间戳列。 */
export const TIMESTAMP_COLUMNS: Record<string, string> = {
  visitor_rollups: "last_ts",
  probe_uptime_daily: "day",
  auth_sessions: "exp",
};

export interface PruneResult {
  table: string;
  deleted: number;
  cutoff: number;
  error?: string;
}

/** 逐表清理过期行；任何一张表失败都不影响其它表。 */
export async function runRetention(
  env: { DB: D1Database },
  now = Math.floor(Date.now() / 1000),
): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  for (const [table, windowSeconds] of Object.entries(BUCKETS)) {
    const column = TIMESTAMP_COLUMNS[table] ?? "ts";
    const cutoff = now - windowSeconds;
    try {
      const res = await env.DB.prepare(
        `DELETE FROM ${table} WHERE ${column} < ?1`,
      )
        .bind(cutoff)
        .run();
      results.push({ table, deleted: res.meta?.changes ?? 0, cutoff });
    } catch (err) {
      results.push({ table, deleted: 0, cutoff, error: String(err).slice(0, 140) });
    }
  }
  console.log(JSON.stringify({ event: "d1_retention", results }));
  return results;
}
