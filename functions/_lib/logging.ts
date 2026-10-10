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

/** 统一结构化事件日志（Pages Functions 侧）。
 *
 * 每个事件输出一行完整 JSON（字段与 Flask 侧 src/app.py 的 log_event 保持一致），
 * 并尝试写入 D1 events 表供行级查询与健康检查聚合。
 * 日志写入失败不影响业务请求。
 */

import { execute, executeBatch } from "./d1";
import type { Env } from "./env";
import { clientCountryForLogs, clientIpForLogs, requestUrl } from "./routing";
import { hmacSha256Hex } from "./crypto";

let eventSchemaReady = false;
/**
 * 上次尝试建表的时间戳（毫秒）。
 *
 * 只记「成功」是不够的：D1 配额耗尽/绑定失效期间每一句 DDL 都必然失败，旧写法
 * 于是让**每个**请求都先打一批失败往返，把一次故障放大成 N 次（docs/22 W9-19）。
 * 现在记住「已尝试」，每个 isolate 每分钟最多重试一次。
 */
let eventSchemaAttemptAt = 0;
const SCHEMA_RETRY_COOLDOWN_MS = 60_000;
const MAX_LOG_MESSAGE_LENGTH = 500;

const SENSITIVE_KEY_RE = /(password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session)/i;
const SENSITIVE_ASSIGNMENT_RE =
  /(password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session|__gate|limooo_session|limooo_pending)\s*=\s*[^&\s,;]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_STRING_RE = /\?[^\s"'<>]+/g;

export interface LogEventFields {
  outcome?: string;
  status?: number;
  host?: string;
  path?: string;
  method?: string;
  message?: string;
  durationMs?: number;
  ip?: string;
  country?: string;
  accountId?: number;
  actorSub?: string;
}

/**
 * 每个 isolate 首次写入前幂等建表，避免依赖人工先执行迁移。
 *
 * 两条约束（docs/22 W9-19）：
 * 1. 记住的是「**已尝试**」而不是「已成功」：D1 故障期间不能让每个请求都先打一批
 *    必然失败的 DDL，否则一次故障被放大成 N 次；失败后每分钟最多重试一次。
 * 2. 四条 DDL 走**一次** `db.batch` 往返，而不是四次串行 `run()`。
 *    只有 `db.batch` 不存在（老驱动/测试桩）时才退回逐句执行。
 */
async function ensureEventSchema(env: Env): Promise<void> {
  if (eventSchemaReady || !env.DB) return;
  const now = Date.now();
  if (now - eventSchemaAttemptAt < SCHEMA_RETRY_COOLDOWN_MS) return;
  eventSchemaAttemptAt = now;
  const ddl = [
    `CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event       TEXT    NOT NULL,
      ts          INTEGER NOT NULL DEFAULT (unixepoch()),
      request_id  TEXT    DEFAULT '',
      host        TEXT    DEFAULT '',
      path        TEXT    DEFAULT '',
      method      TEXT    DEFAULT '',
      status      INTEGER DEFAULT 0,
      outcome     TEXT    DEFAULT '',
      ip_hash     TEXT    DEFAULT '',
      country     TEXT    DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      message     TEXT    DEFAULT '',
      account_id  TEXT    DEFAULT '',
      actor_sub   TEXT    DEFAULT ''
    )`,
    "CREATE INDEX IF NOT EXISTS idx_events_ts_event ON events (ts, event)",
    "CREATE INDEX IF NOT EXISTS idx_events_event_outcome_ts ON events (event, outcome, ts)",
    "CREATE INDEX IF NOT EXISTS idx_events_request_id ON events (request_id)",
  ];
  try {
    const db = env.DB;
    if (db.batch) {
      // executeBatch 在 batch 抛错时返回 false，不会把异常抛出来。
      if (await executeBatch(db, ddl.map((sql) => db.prepare(sql)))) {
        eventSchemaReady = true;
      }
      return;
    }
    for (const sql of ddl) {
      if (!(await execute(env.DB, sql))) return;
    }
    eventSchemaReady = true;
  } catch {
    // D1 尚未就绪时等冷却窗口过后重试，不影响业务。
  }
}

/** request_id：优先使用 Cloudflare Ray ID，便于按边缘日志反查 */
export function requestId(request: Request): string {
  return request.headers.get("CF-Ray") ?? `pages-${crypto.randomUUID()}`;
}

/**
 * IP 脱敏：使用独立的 OBSERVABILITY_HMAC_KEY 做 HMAC-SHA256 并截取前 16 位。
 * 密钥缺失时返回空串（fail-closed），绝不复用 GATE_HMAC_KEY 或使用公开盐值。
 */
export async function ipHash(ip: string, env: Env): Promise<string> {
  if (!ip) return "";
  const key = env.OBSERVABILITY_HMAC_KEY;
  if (!key) return "";
  return (await hmacSha256Hex(key, ip)).slice(0, 16);
}

/** 日志文本脱敏：移除口令、token、Cookie、Bearer 与完整 query，避免敏感值落盘。 */
export function sanitizeLogMessage(message: string): string {
  let out = message
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(SENSITIVE_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(QUERY_STRING_RE, "?[redacted]");
  if (SENSITIVE_KEY_RE.test(out)) {
    out = out.replace(
      /("(?:password|passwd|token|secret|authorization|api[_-]?key|access[_-]?key|cookie|session)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"',
    );
  }
  return out.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

/** 限制 path/message 等文本字段的长度，避免超大错误信息拖垮 D1。 */
function truncate(value: string, maxLength = 2048): string {
  return value.slice(0, maxLength);
}

/** 输出一行 JSON 并尝试持久化到 D1 events 表。 */
export async function logEvent(
  env: Env,
  event: string,
  request: Request,
  fields: LogEventFields = {},
): Promise<void> {
  const url = requestUrl(request);
  const ip = fields.ip ?? clientIpForLogs(request);
  const payload = {
    event,
    ts: Math.floor(Date.now() / 1000),
    request_id: requestId(request),
    host: fields.host ?? url.hostname,
    path: truncate(fields.path ?? url.pathname),
    method: fields.method ?? request.method,
    status: fields.status ?? 0,
    outcome: fields.outcome ?? "",
    ip_hash: await ipHash(ip, env),
    country: fields.country ?? clientCountryForLogs(request),
    duration_ms: fields.durationMs ?? 0,
    message: sanitizeLogMessage(fields.message ?? ""),
    account_id: fields.accountId !== undefined ? String(fields.accountId) : "",
    actor_sub: fields.actorSub ?? "",
  };

  console.log(JSON.stringify(payload));
  if (!env.DB) return;

  try {
    await ensureEventSchema(env);
    const ok = await execute(
      env.DB,
      `INSERT INTO events
        (event, ts, request_id, host, path, method, status, outcome, ip_hash, country, duration_ms, message, account_id, actor_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload.event,
      payload.ts,
      payload.request_id,
      payload.host,
      payload.path,
      payload.method,
      payload.status,
      payload.outcome,
      payload.ip_hash,
      payload.country,
      payload.duration_ms,
      payload.message,
      payload.account_id,
      payload.actor_sub,
    );
    if (!ok) throw new Error("D1 execute returned success=false");
  } catch (error) {
    // 事件表不可用时不能递归写错误事件，只输出到 Pages 日志。
    console.error(
      JSON.stringify({
        event: "event_store_error",
        ts: payload.ts,
        request_id: payload.request_id,
        host: payload.host,
        path: payload.path,
        method: payload.method,
        status: payload.status,
        outcome: "failed",
        message: String(error),
      }),
    );
  }
}
