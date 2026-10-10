-- 017 · 给 ray_log_v2 补 (ip_hash, ts) 索引（docs/22 W7-9 的落地迁移）
--
-- 背景：ray_log_v2（7 天明细表）此前只有 idx_ray_log_v2_ts 一个索引，凡是按
-- ip_hash 过滤的查询都只能扫索引全表。受影响的三处都是排障脚本与接口：
--
--   ops/check_ip_rays.py:168      ... FROM ray_log_v2 WHERE ip_hash IN (...) ORDER BY ts DESC LIMIT n
--   ops/check_visitor_id.py:212   ... FROM ray_log_v2 WHERE ip_hash = '...' ORDER BY ts DESC LIMIT n
--   functions/api/ray/[id].ts:48  ... FROM ray_log_v2 WHERE ray LIKE '...' ORDER BY ts DESC LIMIT 100
--   ops/check_ray_id.py:121       ... FROM ray_log_v2 WHERE ray LIKE '...' ORDER BY ts DESC LIMIT 100
--
-- 线上实测（2026-10-11，wrangler d1 execute limooo --remote）：
--   ray_log_v2   = 2337 行，visitor_rollups = 7270 行
--   EXPLAIN QUERY PLAN（改动前）
--     SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts          ← ip_hash = / IN (...)
--     SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts          ← ray LIKE '...'
--
-- 本索引把前者变成 SEARCH ... USING INDEX idx_ray_log_v2_ip_hash_ts (ip_hash=?)。
-- 排序方向显式写 DESC：两条查询都是 ORDER BY ts DESC，索引方向一致时 SQLite
-- 可以直接沿索引取值，不必再建临时 B-tree 排序。
--
-- 保留期友好：prune_d1.py / status-worker 都按 ts 清理 ray_log_v2，索引跟着
-- 一起缩，不会无限增长。

CREATE INDEX IF NOT EXISTS idx_ray_log_v2_ip_hash_ts
  ON ray_log_v2 (ip_hash, ts DESC);

-- 本迁移**不**恢复 idx_ray_log_v2_host_ts (host, ts)：005_retention.sql:33 建过
-- 它，008_gate_failures.sql:23-25 又刻意删掉了——
--   `-- 下列索引没有生产查询使用，却会放大每条写入；主键/时间索引仍保留。`
-- 这个判断今天依然成立：`grep -rn 'FROM ray_log_v2' functions/ ops/` 的每一处
-- 过滤条件都只有 ts / ip_hash / ray，host 只出现在 SELECT 列表里（d1-archive
-- 归档、check_* 渲染、api/ray 响应），没有任何查询按 host 过滤 ray_log_v2。
-- 所以不重新加它：索引的写放大是真实成本，没有查询受益就不该存在。
--
-- 注意（为什么不能用改 005 的办法补索引）：生产 schema_version 里 005 记录为
-- 旧式纯版本号 5（早于「version*1000+序号」的键格式），migrate_d1.sh 会走
-- `skip (recorded legacy version 5)` 整份跳过 005，所以哪怕在 005 里写
-- CREATE INDEX IF NOT EXISTS 也永远不会执行——补索引只能走新编号迁移（本文件）。
