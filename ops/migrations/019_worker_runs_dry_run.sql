-- 019 · worker_runs.dry_run：把「演练」和「真的推过」区分开
--
-- 018 建 worker_runs 时没有这一列，于是 `GET /?dry-run=1` 也会留下
-- outcome='ok' added=0 removed=0 的一行，和一次真正跑完的同步长得一模一样 ——
-- 而这正是这张表存在的意义（「同步到底有没有真的执行」）。审计表不能有两种
-- 语义相同的记录，所以补一列。
--
-- 语义：
--   dry_run = 1  只算了差异，没有对 Cloudflare 发任何写请求
--   dry_run = 0  真实同步（cron 与 GET / 都是这个）
--
-- 老行（018 到 019 之间产生的）默认 0：那几行确实来自真实同步或真实归档。
--
-- 与 014 / 016 同一套容错：SQLite 的 ADD COLUMN 只做追加，列已存在时
-- `duplicate column name` 由 migrate_d1.sh 走「already applied」容错并补记 19001，
-- 不会中断迁移链。

ALTER TABLE worker_runs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
