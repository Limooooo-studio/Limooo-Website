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
 * 灾备快照：把 D1 的**骨架（全部 DDL）与小型配置/记账表**写进 R2 `backup/`。
 *
 * 为什么需要它（2026-10-11 补的真实缺口）：同一份 D1 只有两条自动路径 ——
 * `analytics/YYYY_MM_DD/`（本 Worker 每天归档 4 张分析表）与保留期清理
 * （ops/status-worker 的 retention.ts）。两条都不含任何配置表：一次全库误删之
 * 后，`blocked_ips`（封禁唯一权威数据）、`apple_accounts`、`auth_credentials`、
 * `schema_version`（迁移记账）与全部建表语句都没有第二份。手工 `wrangler d1 export`
 * 上一次是 2026-09-26，此后无人跑过 —— 手工路径等于没有路径。
 *
 * 与 `analytics/` 的分工（**两条路径语义不同、保留期不同，前缀必须分开**）：
 *   analytics/YYYY_MM_DD/  按**数据所属的 UTC 日**归档明细，只留 4 张分析表，
 *                          目的是「明细过期后还能追查」；
 *   backup/YYYY_MM_DD/     按**快照产生的 UTC 日**取当前状态，DDL + 小表全量，
 *                          目的是「库没了还能重建」。前缀不同，所以下面那份滚动
 *                          清理（只删 backup/ 下的日期前缀）结构上碰不到 analytics/。
 *
 * 读取成本（AGENTS.md「D1 读取预算」，硬要求「每天个位数 × 10² 行」）：
 * 实测 2026-10-11 全路径 422 行/天（sqlite_master 107 + 9 张小表 315 行）。
 * 明细见 README 与 manifest.json 的 `d1_rows_read`；这里**只**读白名单里的表，
 * 大表（heartbeats / events / ray_log_v2 / visitor_rollups / visitors_v2 /
 * visitors / visitors_daily / probe_uptime_daily …）一次都不碰 —— 见 EXCLUDED_TABLES。
 *
 * 类型保真：行数据是 JSONL（每行一个对象）再 gzip，字段名与值原样来自 D1 的
 * 响应对象，不做字符串化、不填默认值，因此 0/1、epoch 整数、NULL 与空串都可区分。
 */

import { gzipJsonl } from "./jsonl";
import { logRun } from "./log";
import { insertRun, runStartedAt, updateRun } from "../../sync-worker/src/runlog";

/**
 * 与 index.ts 里同名结构一致的 D1 形状声明。
 *
 * `meta.rows_read` 是本模块的**成本证据来源**：D1 的 all() 会带回本次语句读了
 * 多少行，快照把它记进 manifest 与 worker_runs，于是「有没有超预算」不需要靠
 * 估算，每天有一条实测数。
 */
export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta?: { rows_read?: number; rows_written?: number };
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  /**
   * 快照本身只读（全走 all()），但运行记录（runlog.updateRun）需要 run()。
   * 这个声明必须与 ops/workers.d.ts 的 D1PreparedStatement 结构一致，否则
   * `D1Database` 不能赋给 runlog 的 `RunDatabase`（tsc: prepare() 返回值不兼容）。
   */
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
}

/** R2 列表的一页；`delimitedPrefixes` 是带 delimiter 时返回的「目录」。 */
export interface R2ListPage {
  objects?: { key: string; size?: number }[];
  delimitedPrefixes?: string[];
  truncated?: boolean;
  cursor?: string;
}

export interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array> | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string } },
  ): Promise<unknown>;
  /** 只有滚动清理会用到 list/delete；真实绑定两个都有。 */
  list(options?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<R2ListPage>;
  delete(keys: string[]): Promise<void>;
}

export interface ArchiveEnv {
  DB: D1Database;
  ARCHIVE: R2Bucket;
}

/** 快照专用前缀。与 analytics/ 严格并列、互不包含。 */
export const BACKUP_PREFIX = "backup/";
/** 运行记录里的任务名（与 ops/migrations/018_worker_runs.sql 的 job 列取值一致）。 */
export const CONFIG_JOB = "config_backup";
/** 滚动保留份数：只留最近 N 个 backup/YYYY_MM_DD/ 前缀。 */
export const KEEP_SNAPSHOTS = 14;

/**
 * 只认 `backup/YYYY_MM_DD/` 这种形状的日期前缀。
 *
 * 清理是**唯一**会删对象的代码，所以它只对白名单形状动手：手工放进 `backup/`
 * 的其它对象（例如 `backup/notes.txt`、`backup/manual/`）永远不参与轮换，
 * 宁可让它们留着，也不允许「按前缀批量删」误伤。
 */
const DAY_PREFIX = /^backup\/\d{4}_\d{2}_\d{2}\/$/;

/**
 * sqlite_master 里属于引擎/平台的内部对象：出现在 schema.jsonl.gz（无损），
 * 但不进可重放的 ddl.sql —— `sqlite_sequence` 是保留名（手工 CREATE 会报
 * "object name reserved for internal use"），`_cf_KV` 是 Cloudflare 自管表
 * （D1 直接拒绝读写：SQLITE_AUTH / code 7500）。
 */
const INTERNAL_OBJECT = /^(sqlite_|_cf_)/;

/**
 * 快照里的 .jsonl.gz 用 application/gzip，**故意不写 contentEncoding**。
 *
 * 实测（2026-10-11，两种对象各下了一次）：
 *   - analytics/ 那种 `contentEncoding: "gzip"` 的对象，经 R2 REST API 与
 *     `wrangler r2 object get` 下载回来的都是**解压后**的明文（624 字节的对象
 *     落地 1290 字节），文件名却还叫 .jsonl.gz —— gunzip 直接报 not in gzip format；
 *   - 不带 contentEncoding 的对象下载字节与上传字节 md5 一致。
 * 灾备对象的唯一用途就是「下载下来照着还原」，名字与实际字节必须一致，所以这里
 * 声明内容类型是 gzip 而不是让传输层偷偷解压。analytics/ 的元数据一行不动。
 */
const GZIP_METADATA = {
  httpMetadata: { contentType: "application/gzip" },
} as const;
const SQL_METADATA = { httpMetadata: { contentType: "text/plain; charset=utf-8" } } as const;
const JSON_METADATA = { httpMetadata: { contentType: "application/json" } } as const;

export interface ConfigTableSpec {
  name: string;
  /** 快照内的行序：一律走主键，保证同一天重复执行产出同样的字节。 */
  orderBy: string;
  /** 为什么这张表必须进快照（写进 manifest，让备份自己解释自己）。 */
  why: string;
}

/**
 * 进快照的表：**只增不改**的白名单，任何新增都要重新算一遍读预算。
 *
 * 全部是「重建之后手工敲不回来」的小表：封禁权威数据、账号/凭据、探针与保留期
 * 的配置、迁移记账、运行/审计历史。行数都在 10² 量级，见 README 的实测表。
 */
export const CONFIG_TABLES: readonly ConfigTableSpec[] = [
  {
    name: "schema_version",
    orderBy: "version",
    why: "Migration bookkeeping; migrate_d1.sh skips an already-applied file by these rows, so a restore that loses them re-runs migrations.",
  },
  {
    name: "blocked_ips",
    orderBy: "cidr",
    why: "The authoritative block list (AGENTS.md). data/blocklist.txt is only an auditable snapshot of it.",
  },
  {
    name: "apple_accounts",
    orderBy: "id",
    why: "Admin account records, already encrypted at rest; copied verbatim, never decrypted here.",
  },
  {
    name: "auth_credentials",
    orderBy: "email",
    why: "Local credential rows (pbkdf2 hashes + lockouts). Copied verbatim, never decrypted here.",
  },
  {
    name: "probes",
    orderBy: "id",
    why: "Probe definitions (targets, groups, intervals); the status page has nothing to show without them.",
  },
  {
    name: "probe_state",
    orderBy: "probe_id",
    why: "Per-probe alert state (down_since, last_alert_at); losing it re-fires alerts for existing outages.",
  },
  {
    name: "retention_state",
    orderBy: "name",
    why: "Retention bookkeeping (last_run_at / last_success_at / last_error) per bucket.",
  },
  {
    name: "blocklist_audit",
    orderBy: "id",
    why: "Every block/unblock with its previous values: the rollback basis AGENTS.md promises.",
  },
  {
    name: "worker_runs",
    orderBy: "id",
    why: "Cron run history for all jobs; the only record of whether the sync/archive actually ran.",
  },
];

export interface ExcludedTable {
  name: string;
  why: string;
}

/**
 * 明确排除的表与理由。写进 manifest，所以「哪张表为什么没有备份」随备份一起走，
 * 不必回仓库翻文档。
 */
export const EXCLUDED_TABLES: readonly ExcludedTable[] = [
  {
    name: "visitors",
    why: "Legacy VPS-era table (~13.9k rows, plaintext ip TEXT). No code reads it since the 2026-09-17 edge migration, and copying it would put plaintext IPs into a second store.",
  },
  {
    name: "visitors_daily",
    why: "Derived aggregate (~11.3k rows) rebuilt from visitors_v2 + visitor_rollups by ops/prune_d1.py --mode aggregate. Only its schema is in this snapshot.",
  },
  {
    name: "visitor_rollups",
    why: "Already archived every day to analytics/YYYY_MM_DD/ (90-day window) by this Worker; separate prefix and separate retention on purpose.",
  },
  {
    name: "visitors_v2",
    why: "Already archived every day to analytics/YYYY_MM_DD/ (30-day window); read daily by the analytics path, not here.",
  },
  {
    name: "ray_log_v2",
    why: "Already archived every day to analytics/YYYY_MM_DD/ (7-day window); the biggest detail table.",
  },
  {
    name: "events",
    why: "Already archived every day to analytics/YYYY_MM_DD/ (90-day window).",
  },
  {
    name: "heartbeats",
    why: "Probe liveness detail at ~3 rows/minute, pruned after 30 days. Bulk telemetry, not configuration.",
  },
  {
    name: "probe_uptime_daily",
    why: "Daily uptime rollup: irreplaceable beyond the 30-day heartbeats window, but a volume table (90 days x probes). A separate windowed copy is the better vehicle if the status page history must be recoverable.",
  },
  {
    name: "ray_log",
    why: "Legacy table superseded by ray_log_v2, which the analytics/ archive already covers.",
  },
  {
    name: "gate_failures",
    why: "Short-window brute-force counters keyed by ip_hash; self-healing state with no restore value.",
  },
  {
    name: "auth_sessions",
    why: "Revocable Cloudflare Access sessions; logging in again is the recovery path and the table self-prunes by exp.",
  },
  {
    name: "_cf_KV",
    why: "Cloudflare-managed internal table; D1 rejects reads and writes with SQLITE_AUTH (code 7500), so no row copy is possible.",
  },
];

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

/** 建表语句必须先于索引出现：sqlite_master 自身的顺序没有任何保证。 */
const TYPE_RANK: Record<string, number> = { table: 0, index: 1, trigger: 2, view: 3 };

export const SCHEMA_SQL = `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY type, name`;

export function orderSchema(rows: SchemaRow[]): SchemaRow[] {
  return [...rows].sort((a, b) => {
    const rankA = TYPE_RANK[a.type] ?? 9;
    const rankB = TYPE_RANK[b.type] ?? 9;
    if (rankA !== rankB) return rankA - rankB;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
}

/** 快照前缀所属的 UTC 日（**运行日**，不是数据日；analytics/ 用的是数据日）。 */
export function utcDayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "_");
}

export function snapshotPrefix(day: string): string {
  return `${BACKUP_PREFIX}${day}/`;
}

/** 删除前的最后一道闸：键必须落在 backup/ 之内。 */
export function isBackupKey(key: string): boolean {
  return key.startsWith(BACKUP_PREFIX) && key.length > BACKUP_PREFIX.length;
}

/**
 * 把 sqlite_master 的行渲染成**可重放**的 ddl.sql。
 *
 * 逐字保留 D1 里存的 SQL 文本（只去掉结尾的分号再补一个，避免 `;;`），因为
 * 这正是「重建的骨架」——任何美化/重排都会让「和线上是不是同一份定义」变得
 * 不可比对。内部对象不写进去，但**列在头部注释里**，所以读者不会以为漏了。
 */
export function buildDdl(rows: SchemaRow[], generatedAt: number): { sql: string; skipped: string[] } {
  const ordered = orderSchema(rows);
  const skipped: string[] = [];
  const statements: string[] = [];
  for (const row of ordered) {
    if (INTERNAL_OBJECT.test(row.name)) {
      skipped.push(row.name);
      continue;
    }
    statements.push(`${row.sql.trim().replace(/;+$/, "")};\n`);
  }
  const iso = new Date(generatedAt * 1000).toISOString();
  const header = [
    "-- Limooo D1 configuration & schema snapshot",
    `-- generated_at: ${iso}  (unix ${generatedAt})`,
    "-- source: ops/d1-archive, scheduled job config_backup",
    "--         SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL",
    "-- scope: DDL only. This file recreates the empty skeleton, never the rows.",
    "--        Rows live beside it: <table>.jsonl.gz, schema.jsonl.gz, manifest.json.",
    "-- order: tables first, then indexes (sqlite_master has no guaranteed order).",
    "-- restore into a FRESH database:",
    "--   wrangler d1 execute <database> --remote --file ddl.sql",
    "--   python3 ops/d1-archive/restore.py --dir <downloaded dir> --out data.sql",
    "--   wrangler d1 execute <database> --remote --file data.sql",
    "-- deliberately absent (engine/platform objects, kept verbatim in schema.jsonl.gz):",
    ...(skipped.length ? skipped.map((name) => `--   ${name}`) : ["--   -"]),
    "",
    "",
  ].join("\n");
  return { sql: header + statements.join("\n"), skipped };
}

export interface TableReport {
  name: string;
  rows: number;
  bytes: number;
  error: string | null;
}

export interface SnapshotResult {
  day: string;
  prefix: string;
  generatedAt: number;
  /** D1 实测读行数（各语句 meta.rows_read 之和）—— 这条路径的成本证据。 */
  rowsRead: number;
  objects: string[];
  tables: TableReport[];
  skippedObjects: string[];
  errors: string[];
}

/**
 * 写一天的快照。R2 权限或 sqlite_master 读失败会**抛出**（没有骨架就没有快照）；
 * 单张表失败不抛，写进 manifest 与返回值里的 errors，并计入 failed 运行记录。
 */
export async function snapshotConfig(env: ArchiveEnv, now = new Date()): Promise<SnapshotResult> {
  const day = utcDayStamp(now);
  const prefix = snapshotPrefix(day);
  const generatedAt = runStartedAt(now.getTime());
  let rowsRead = 0;
  const objects: string[] = [];
  const tables: TableReport[] = [];
  const errors: string[] = [];

  const schemaQuery = await env.DB.prepare(SCHEMA_SQL).all<SchemaRow>();
  rowsRead += schemaQuery.meta?.rows_read ?? 0;
  const schemaRows = schemaQuery.results ?? [];

  // 无损的 sqlite_master 原样副本：ddl.sql 是它的可重放子集，两者一起才是全量。
  const schemaPayload = await gzipJsonl(orderSchema(schemaRows));
  await env.ARCHIVE.put(`${prefix}schema.jsonl.gz`, schemaPayload, GZIP_METADATA);
  objects.push("schema.jsonl.gz");

  const ddl = buildDdl(schemaRows, generatedAt);
  await env.ARCHIVE.put(`${prefix}ddl.sql`, ddl.sql, SQL_METADATA);
  objects.push("ddl.sql");
  const ddlWritten = true;

  for (const spec of CONFIG_TABLES) {
    try {
      const result = await env.DB.prepare(`SELECT * FROM ${spec.name} ORDER BY ${spec.orderBy}`).all();
      rowsRead += result.meta?.rows_read ?? 0;
      const rows = result.results ?? [];
      const payload = await gzipJsonl(rows);
      await env.ARCHIVE.put(`${prefix}${spec.name}.jsonl.gz`, payload, GZIP_METADATA);
      objects.push(`${spec.name}.jsonl.gz`);
      tables.push({ name: spec.name, rows: rows.length, bytes: payload.byteLength, error: null });
    } catch (error) {
      // 一张表读不到不能让其余八张一起丢：先把它记成缺口，继续写别的。
      errors.push(`${spec.name}: ${String(error)}`);
      tables.push({ name: spec.name, rows: 0, bytes: 0, error: String(error) });
      logRun(CONFIG_JOB, {
        outcome: "failed",
        stage: "table",
        table: spec.name,
        error: String(error),
      });
    }
  }

  const manifest = {
    job: CONFIG_JOB,
    day,
    prefix,
    generated_at: generatedAt,
    generated_at_iso: new Date(generatedAt * 1000).toISOString(),
    keep_snapshots: KEEP_SNAPSHOTS,
    d1_rows_read: rowsRead,
    ddl_written: ddlWritten,
    objects: [...objects, "manifest.json"],
    schema_objects: orderSchema(schemaRows).length,
    skipped_internal_objects: ddl.skipped,
    tables,
    excluded_tables: EXCLUDED_TABLES,
    restore: {
      ddl: "wrangler d1 execute <database> --remote --file ddl.sql",
      data: "python3 ops/d1-archive/restore.py --dir <dir> --out data.sql",
      apply: "wrangler d1 execute <database> --remote --file data.sql",
    },
  };
  await env.ARCHIVE.put(`${prefix}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, JSON_METADATA);
  objects.push("manifest.json");

  return {
    day,
    prefix,
    generatedAt,
    rowsRead,
    objects,
    tables,
    skippedObjects: ddl.skipped,
    errors,
  };
}

export interface PruneResult {
  kept: string[];
  /** 本次看到且形状合法的日期前缀（升序），用于回执与断言。 */
  scanning: string[];
  deletedKeys: string[];
}

/** 按 delimiter 翻完整个目录层，避免 1000 条一页的列表把前缀截断。 */
async function listDayPrefixes(bucket: R2Bucket): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: "/", cursor });
    for (const prefix of page.delimitedPrefixes ?? []) found.push(prefix);
    if (!page.truncated || !page.cursor) break;
    cursor = page.cursor;
  }
  return found;
}

/**
 * 滚动清理：只留最近 `keep` 个 `backup/YYYY_MM_DD/` 前缀，更早的整份删掉。
 *
 * 为什么是前缀而不是「按对象年龄」：一天的快照是一组对象（ddl.sql + 9 张表 +
 * schema + manifest），要么整份留、要么整份删；按对象删会出现「ddl 还在、表没了」
 * 这种比没有备份更坏的状态。
 *
 * 两条独立保证，确保**结构上碰不到 analytics/**：
 *   1. 列目录只发 `prefix: "backup/"`，R2 根本不会返回 backup/ 之外的前缀；
 *   2. 每个待删键在提交前再过一次 isBackupKey()，删的是 list 回来的具体键，
 *      而不是自己拼出来的路径。
 * 另外只认 DAY_PREFIX 形状，手工放进去的对象不参与轮换。
 */
export async function pruneBackups(bucket: R2Bucket, keep = KEEP_SNAPSHOTS): Promise<PruneResult> {
  const wanted = Math.max(1, Math.trunc(keep));
  const dayPrefixes = [...new Set(await listDayPrefixes(bucket))]
    .filter((prefix) => DAY_PREFIX.test(prefix))
    .sort();
  const stale = dayPrefixes.slice(0, Math.max(0, dayPrefixes.length - wanted));
  const deletedKeys: string[] = [];

  for (const prefix of stale) {
    // list 之后、delete 之前再判一次：白名单是每次删除前的唯一依据。
    if (!DAY_PREFIX.test(prefix)) continue;
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix, cursor });
      for (const object of page.objects ?? []) {
        if (isBackupKey(object.key)) keys.push(object.key);
      }
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    if (!keys.length) continue;
    await bucket.delete(keys);
    deletedKeys.push(...keys);
  }

  return { kept: dayPrefixes.slice(-wanted), scanning: dayPrefixes, deletedKeys };
}

export interface ConfigBackupResult {
  runId: number | null;
  day: string;
  rowsRead: number;
  exportedRows: number;
  objects: number;
  deleted: number;
  errors: string[];
  outcome: "ok" | "failed";
}

/**
 * scheduled() 的第二个 stage：写快照 + 滚动清理，并落一行 worker_runs。
 *
 * 与 runArchive 同形（insert → 干活 → update），但用**自己的 job 值**
 * `config_backup`：worker_runs 的 `?health=1` 取的是「每个 job 最近一条」，
 * 复用 d1_archive 会让两个 stage 交替覆盖同一条序列，于是「归档失败」和
 * 「快照失败」再也分不开 —— 而这个表存在的全部意义就是分清失败。
 *
 * 列语义（写进 README）：
 *   added   = 本次 D1 实测读行数（meta.rows_read 之和），也就是成本；
 *   removed = 本次滚动清理删掉的 R2 对象数；
 *   error   = 单表失败 / 清理失败的原因，逗号分隔；为空即 ok。
 */
export async function runConfigBackup(
  env: ArchiveEnv,
  now = new Date(),
  keep = KEEP_SNAPSHOTS,
): Promise<ConfigBackupResult> {
  const startedAt = runStartedAt();
  const runId = await insertRun(env.DB, CONFIG_JOB, startedAt);
  logRun(CONFIG_JOB, { outcome: "started" });

  let snapshot: SnapshotResult;
  try {
    snapshot = await snapshotConfig(env, now);
  } catch (error) {
    await updateRun(env.DB, runId, {
      finishedAt: runStartedAt(),
      outcome: "failed",
      error: String(error),
    });
    logRun(CONFIG_JOB, {
      outcome: "failed",
      stage: "snapshot",
      error: String(error),
      duration_ms: runStartedAt() - startedAt,
    });
    throw error;
  }

  const errors = [...snapshot.errors];
  let deleted = 0;
  try {
    // 触到 ddl.sql 才轮换：整天没写出去时**不删**，否则失败一次就白掉最老的一份。
    // 轮换按时间而不是按「今天是否完整」推进，理由见 README：坏掉的一天不能把
    // 桶钉死在无限增长上，完整性由 manifest 与 worker_runs 的 failed 如实记录。
    const pruned = await pruneBackups(env.ARCHIVE, keep);
    deleted = pruned.deletedKeys.length;
  } catch (error) {
    errors.push(`retention: ${String(error)}`);
    logRun(CONFIG_JOB, { outcome: "failed", stage: "retention", error: String(error) });
  }

  const exportedRows = snapshot.tables.reduce((sum, table) => sum + table.rows, 0);
  const outcome = errors.length ? "failed" : "ok";
  await updateRun(env.DB, runId, {
    finishedAt: runStartedAt(),
    outcome,
    added: snapshot.rowsRead,
    removed: deleted,
    error: errors.length ? errors.join("; ") : null,
    dryRun: false,
  });
  logRun(CONFIG_JOB, {
    outcome,
    day: snapshot.day,
    rows_read: snapshot.rowsRead,
    exported_rows: exportedRows,
    objects: snapshot.objects.length,
    deleted,
    errors,
    duration_ms: runStartedAt() - startedAt,
  });

  return {
    runId,
    day: snapshot.day,
    rowsRead: snapshot.rowsRead,
    exportedRows,
    objects: snapshot.objects.length,
    deleted,
    errors,
    outcome,
  };
}
