-- 016 · 补齐 probe_state.last_alert_at（down 告警冷却）
--
-- 该列此前只在生产库上手工 ALTER 过，仓库里没有对应迁移：009_probes.sql 建
-- probe_state 时只有 probe_id / last_status / consecutive_fail / down_since /
-- checked_at，而 ops/status-worker/src/index.ts 的 maybeAlert() 要读写它：
--   SELECT last_alert_at FROM probe_state WHERE probe_id = ?1
--   UPDATE probe_state SET last_alert_at = ?2 WHERE probe_id = ?1
-- 证据：ops/backups/d1-limooo-20260926-062521.sql 里该表定义结尾是
--   `, last_alert_at INTEGER);`——生产库是靠手工 ALTER 才有这一列的。
--
-- 后果：按 ops/migrations/ 重建的新库缺列 → 那条 SELECT 抛错、被 maybeAlert()
-- 的 try/catch 静默吞掉 → 告警冷却失效，探针抖动时会重复发信。
--
-- 已有库（含生产库）已有该列，SQLite 的 ADD COLUMN 只做追加。是否已应用由 D1
-- 的 schema_version 判定（键 = version*1000+序号，本文件为 16001）；migrate_d1.sh
-- 本地那份 .d1-migrations/applied 只是离线计划缓存，不参与跳过判断。
-- 因此该列已存在的生产库执行本迁移时，脚本会走「already applied」容错并补记 16001，
-- 不会因 duplicate column name 中断。形式上与 012 / 014 两条补列迁移一致。

ALTER TABLE probe_state ADD COLUMN last_alert_at INTEGER;
