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
 * `worker_runs` 运行记录的共享库（表结构见 ops/migrations/018_worker_runs.sql）。
 *
 * 为什么有这个文件：limooo-blocklist-sync 与 limooo-d1-archive 都用
 * `ctx.waitUntil(asyncWork(env))`，协程 rejection 被静默吞掉，失败了没有任何
 * 痕迹。两个 Worker 的运行记录形状必须一致，否则运维脚本要写两套解析，所以
 * 逻辑只此一份，d1-archive 直接相对导入本文件（wrangler 会把被引用的模块一起
 * 打包；这正是「一个模块只能有一个源」的取舍：宁可跨目录引用，也不复制一份
 * 必然会漂移的实现）。
 *
 * 成本纪律（AGENTS.md「D1 读取预算」）：
 *   - 写：每个 job 每次运行 1 次 INSERT + 1 次 UPDATE，cron 频率下是 1 行/天；
 *   - 读：只有 Worker 的 `?health=1` 端点与 ops/check_blocklist_sync.py 会读，
 *         各 job 的**热路径**（同步、归档）一次都不读；
 *   - 索引 (job, started_at DESC) 与 health 的 `WHERE job = ? ORDER BY
 *         started_at DESC LIMIT 1` 完全对应，只读 1 行。
 *
 * 失败语义：本文件所有函数**都不抛错**（除了 lastRun，它的失败由调用方兜）。
 * 写不进去只 console.error，绝不让「记账失败」变成「同步/归档失败」。
 */

/** 与 ops/migrations/018_worker_runs.sql 的列一一对应。 */
export interface RunRow {
  id: number;
  job: string;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  added: number | null;
  removed: number | null;
  error: string | null;
  /** 1 = 只算了差异、没对 Cloudflare 发写请求（`?dry-run=1`）。 */
  dry_run: number;
}

export interface RunUpdate {
  finishedAt: number;
  outcome: string;
  added?: number;
  removed?: number;
  error?: string | null;
  dryRun?: boolean;
}

/**
 * 只要求 Worker 真正用到的那点 D1 形状，便于测试桩。
 *
 * 关键：必须与 ops/workers.d.ts 的 D1PreparedStatement **结构兼容**，否则
 * `D1Database` 不能赋给 `RunDatabase`（tsc 会报 prepare() 返回值不兼容）。
 * 因此 `all()` 的返回把 results/success 标成可选 —— 这样既接受真实的
 * `D1Result<T>`（字段齐全），也接受测试里只给一部分字段的桩对象。`run()` 用
 * `Promise<unknown>` 而不是 `Promise<D1Result>`，调用方本来就不看它的返回值。
 */
interface RunStatement {
  bind(...values: unknown[]): RunStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[]; success?: boolean }>;
  run(): Promise<unknown>;
}

/** 只要求 Worker 真正用到的那点 D1 形状，便于测试桩。 */
export interface RunDatabase {
  prepare(sql: string): RunStatement;
}

/** 运行记录里的时间戳：UTC epoch 秒（与 D1 其余表一致）。 */
export function runStartedAt(now = Date.now()): number {
  return Math.floor(now / 1000);
}

/** 写失败时的结构化日志；带 job 与 stage，便于在 Workers 日志里检索。 */
function logRunStoreError(job: string, stage: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "worker_run_store_error",
      job,
      stage,
      outcome: "failed",
      error: String(error),
    }),
  );
}

/**
 * 记下「开始跑」：outcome='running'、finished_at 为 NULL。
 *
 * 返回行 id 供结束时回填；写不进去返回 null（调用方照样继续跑同步）。
 */
export async function insertRun(
  db: RunDatabase,
  job: string,
  startedAt = runStartedAt(),
): Promise<number | null> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO worker_runs (job, started_at, outcome)
         VALUES (?, ?, 'running')
         RETURNING id`,
      )
      .bind(job, startedAt)
      .all<{ id: number }>();
    const id = result?.results?.[0]?.id;
    return typeof id === "number" ? id : null;
  } catch (error) {
    logRunStoreError(job, "insert", error);
    return null;
  }
}

/** 回填结束状态。runId 为 null（insert 失败）时直接跳过。 */
export async function updateRun(
  db: RunDatabase,
  runId: number | null,
  update: RunUpdate,
): Promise<boolean> {
  if (runId === null || runId === undefined) return false;
  try {
    await db
      .prepare(
        `UPDATE worker_runs
            SET finished_at = ?, outcome = ?, added = ?, removed = ?, error = ?, dry_run = ?
          WHERE id = ?`,
      )
      .bind(
        update.finishedAt,
        update.outcome,
        update.added ?? null,
        update.removed ?? null,
        update.error === undefined ? null : update.error,
        update.dryRun ? 1 : 0,
        runId,
      )
      .run();
    return true;
  } catch (error) {
    logRunStoreError(String(update.outcome), "update", error);
    return false;
  }
}

/**
 * 读最近一条运行记录（每个 job 一行）。
 *
 * 与其它函数不同，这里**会把异常抛出去**：健康端点的返回值里「lastRun 为
 * null」有两种含义 —— 表还没建（迁移 018 没跑）与查询失败；让调用方拿到异常
 * 才能如实说明，而不是把两者混成「没有记录」。查询走
 * idx_worker_runs_job_started，只读 1 行。
 */
export async function lastRun(db: RunDatabase, job: string): Promise<RunRow | null> {
  const result = await db
    .prepare(
      `SELECT id, job, started_at, finished_at, outcome, added, removed, error, dry_run
         FROM worker_runs
        WHERE job = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(job)
    .all<RunRow>();
  return result?.results?.[0] ?? null;
}
