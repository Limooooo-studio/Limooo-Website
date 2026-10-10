-- 018 · worker_runs：把 Cron Worker 的每次运行记成一行，让失败可见
--
-- 背景（2026-10-11 实测）：limooo-blocklist-sync 与 limooo-d1-archive 两个 Worker
-- 的 scheduled() 都写成 `ctx.waitUntil(asyncWork(env))` —— 协程的 rejection 被
-- waitUntil 静默吞掉，Cloudflare 的 cron 面板照样显示「已运行/成功」。同步真的
-- 失败时没有任何人能发现，只能靠人肉去翻 Workers 日志或 R2。
--
-- 这张表就是那个缺失的证据面：每个 job 每次运行一行，成功与失败都记，失败带
-- error 文本。读取只发生在运维脚本（ops/check_blocklist_sync.py）与 Worker 的
-- /  健康端点；Worker 的**热路径**（同步、归档）绝不查它，避免给 D1 读预算
-- 添行（见 AGENTS.md「D1 读取预算」）。
--
-- 写入量：blocklist_sync 1 行/天（cron 30 3 * * *）、d1_archive 1 行/天
-- （cron 0 0 * * *），外加运维脚本手工跑的次数。一次 INSERT + 一次 UPDATE。
--
-- job 列让两个 Worker 共用一张表而不是各建一张：schema 只有一处，运维脚本一次
-- 查询就能按 job 分组取出「每个任务最近一次跑成什么样」。
--
-- 写入约定（两侧 Worker 同源，见 ops/sync-worker/src/runlog.ts）：
--   started_at     INSERT 时就写（outcome='running'，finished_at 为 NULL）
--   outcome        成功回填 ok / 失败回填 failed；缺凭据提前返回记 skipped
--   added/removed  本次增量条目数，不适用时为 NULL
-- 写入失败一律 fail-open：只 console.error，绝不影响被记录的同步/归档本身。
--
-- 幂等：全部 CREATE ... IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS worker_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job         TEXT    NOT NULL DEFAULT 'blocklist_sync',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    outcome     TEXT    NOT NULL DEFAULT 'running',
    added       INTEGER,
    removed     INTEGER,
    error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_runs_job_started
    ON worker_runs (job, started_at DESC);
