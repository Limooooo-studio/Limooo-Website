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
 * `worker_runs` 的「有人在看」那一环（迁移 018）。
 *
 * 迁移 018 让两个 cron Worker 把每次运行记成一行，但**没有任何人或任何任务是
 * 那张表的读者**：失败写进去了，仍然不会通知到人（`ops/check_blocklist_sync.py`
 * 是手工入口，实测被自动化调用 0 处）。本文件补上读者——status-worker 的
 * 每日任务（cron `47 3 * * *`，恰好排在归档 `0 0 * * *` 与同步 `30 3 * * *`
 * 之后）读每个 job 的最近一次运行，异常就交给现有告警通道。
 *
 * 成本纪律（AGENTS.md「D1 读取预算」）：
 *   - **每天只跑一次**，且只在 `47 3 * * *` 分支里；绝不放进每分钟的探针 cron。
 *   - 查询形状是「每个 job 各走一次索引 seek、各读 1 行」，不是范围扫、不是
 *     `COUNT(*)`、也不是 `IN (SELECT MAX(id) ... GROUP BY job)`。
 *
 *     为什么不用后者（它是「每 job 取最近一行」最直觉的写法）：实测
 *     `EXPLAIN QUERY PLAN` 显示它会对 `idx_worker_runs_job_started` 做
 *     **SCAN**（整索引扫），线上实测 `rows_read=10`（当时表里只有 6 行！），
 *     行数随表增长——与「个位数行读取/天」的预算直接冲突。现在的写法在线实测
 *     `rows_read=2`（两个 job），且随 job 数量线性、与表大小无关：
 *         SEARCH worker_runs USING INDEX idx_worker_runs_job_started (job=?)
 *
 *   - 排序键只用 `started_at DESC`（不带 `id DESC`）：索引就是
 *     `(job, started_at DESC)`，加上 id 之后 SQLite 无法用索引满足 ORDER BY，
 *     会退化成「扫完该 job 的所有行再排序」。线上实测同一个 job：只按
 *     `started_at DESC` = 1 行，加 `, id DESC` = 3 行（该 job 当时有 3 行）。
 *     同理 `ORDER BY id DESC` = 7 行。见 ops/sync-worker/src/runlog.ts 的 lastRun，
 *     它是「读一行」的场景却用了 `started_at DESC, id DESC`。
 *
 * 失败一律 fail-open：表不存在（迁移未应用）或读失败时**只记日志、不报警**，
 * 也绝不抛给调用方——每日任务里还有 D1 保留清理，不能被这一步带倒。
 */

/**
 * 被监视的 cron 任务名，与写 `worker_runs` 的那几个 JOB 常量一一对应：
 *   - `blocklist_sync`        ops/sync-worker/src/index.ts        (cron 30 3 * * *)
 *   - `d1_archive`            ops/d1-archive/src/index.ts        (cron 0 0 * * *)
 *   - `config_backup`         ops/d1-archive/src/config-backup.ts（同一个 d1-archive cron）
 *   - `blocklist_sync_check`  是 ops/check_blocklist_sync.py --record 的手工记录，
 *     **故意不看**：手工检查没跑不等于故障。
 *
 * 这是一个常量而不是 `SELECT DISTINCT job`：后者要扫整张索引（每行都读），
 * 而这里每个 job 只读 1 行。代价是**新增 job 时必须往这里加一行**——没加就等于
 * 那个 job 的失败仍然没人看（本文件存在的理由），所以加 job 的改动要连着改这里。
 */
export const WATCHED_JOBS = ["blocklist_sync", "d1_archive", "config_backup"] as const;

/**
 * `running` 多久才算异常（秒）。
 *
 * `started_at` 是 INSERT 时就写的，任务正在跑的那一刻必然停在 `running`；
 * 没有阈值就会在「检查恰好撞上任务执行」时误报。两个 cron 任务的实测耗时都是
 * 秒级（同步 1 秒、归档数十秒），2 小时远超任何正常运行时长，只会捞到真正
 * 卡死/被杀掉的进程。
 */
export const STALE_RUNNING_S = 2 * 3600;

/** 结果里正常、无需告警的 outcome。 */
const HEALTHY_OUTCOMES = new Set(["ok", "skipped"]);

/** error 摘要的最大长度（告警文案里只留摘要，原文留在表里可查）。 */
export const ERROR_SUMMARY_CHARS = 200;

export interface LatestRun {
  job: string;
  outcome: string;
  started_at: number;
  error: string | null;
}

export interface RunIssue {
  job: string;
  outcome: string;
  started_at: number;
  /** 告警文案里的一行说明：outcome + 时间 + error 摘要。 */
  detail: string;
}

export interface LatestRunsResult {
  rows: LatestRun[];
  /** 读失败的原因（表不存在/网络）。**有值 ≠ 没有异常运行**，两者不能混。 */
  error?: string;
}

/**
 * 「每 job 最近一行」的 SQL：每个 job 一个 `WHERE job = ?` + `LIMIT 1` 的
 * 索引 seek，用 `UNION ALL` 拼成**一条**语句（一次 prepare、一次往返，
 * 测试里可用 spy 断言「这张表只读一次」）。
 */
export function latestRunsSql(jobs: readonly string[] = WATCHED_JOBS): string {
  return jobs
    .map(
      (_job, i) =>
        "SELECT job, outcome, started_at, error FROM (" +
        "SELECT job, outcome, started_at, error FROM worker_runs " +
        `WHERE job = ?${i + 1} ORDER BY started_at DESC LIMIT 1)`,
    )
    .join(" UNION ALL ");
}

/**
 * 读每个 job 的最近一次运行。任何失败（含「表不存在」）都返回 `error`，
 * 绝不抛——调用方据此只记日志。
 */
export async function readLatestRuns(
  db: D1Database,
  jobs: readonly string[] = WATCHED_JOBS,
): Promise<LatestRunsResult> {
  try {
    const stmt = db.prepare(latestRunsSql(jobs));
    const res = await (jobs.length ? stmt.bind(...jobs) : stmt).all<LatestRun>();
    return { rows: res.results ?? [] };
  } catch (err) {
    return { rows: [], error: String(err).slice(0, 140) };
  }
}

/** 时间戳 → `2026-10-12 03:30:00 UTC`；与告警邮件的 when 格式保持一致。 */
export function formatUtc(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "-";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** error 摘要：压平换行、截断，避免把整段堆栈塞进告警。 */
export function errorSummary(error: unknown): string {
  const flat = String(error ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "-";
  return flat.length > ERROR_SUMMARY_CHARS ? `${flat.slice(0, ERROR_SUMMARY_CHARS)}…` : flat;
}

/**
 * 从最近一行判定要不要告警（纯函数）：
 *   - `ok` / `skipped`        → 正常（同步「没凭据所以没跑」是预期状态，不是故障）
 *   - `running` 且已超阈值     → 异常（卡死/被杀，finished_at 永远回填不上）
 *   - `running` 未超阈值       → 正常（任务正在跑）
 *   - 其它（`failed`/未知值）  → 异常：宁可多报一条，也不要让一个新的 outcome
 *                              取值悄悄变成「没人看」
 */
export function runIssues(
  rows: readonly LatestRun[],
  now: number,
  staleRunningS: number = STALE_RUNNING_S,
): RunIssue[] {
  const issues: RunIssue[] = [];
  for (const row of rows) {
    const outcome = String(row.outcome ?? "").trim().toLowerCase();
    if (HEALTHY_OUTCOMES.has(outcome)) continue;
    const startedAt = Number(row.started_at);
    if (outcome === "running" && now - startedAt < staleRunningS) continue;
    issues.push({
      job: row.job,
      outcome,
      started_at: startedAt,
      detail:
        `outcome=${outcome} · started ${formatUtc(startedAt)} · ` +
        `error: ${errorSummary(row.error)}`,
    });
  }
  return issues;
}
