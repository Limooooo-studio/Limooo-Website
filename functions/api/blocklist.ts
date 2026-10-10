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
 * GET /api/blocklist            — admin-only，分页查询
 * POST /api/blocklist           — admin-only，加封/重新激活
 * DELETE /api/blocklist?cidr=…  — admin-only，解封（软删除 + 审计）
 *
 * D1 blocked_ips 是唯一权威源；每次变更同时写 blocklist_audit 与 events。
 */

import { execute, executeBatch, queryAll } from "../_lib/d1";
import { logEvent } from "../_lib/logging";
import { parseCidr } from "../_lib/cidr";
import { requireAdminSession } from "../_lib/session";
import { verifyCsrf } from "../_lib/csrf";
import type { Env } from "../_lib/env";

interface BlockedRow {
  cidr: string;
  network: string;
  prefix: number;
  reason: string;
  source: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  active: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** 封禁理由的长度上限：与其余字符串字段的 cap 口径一致，防单行写爆库。 */
const BLOCKLIST_REASON_MAX_LENGTH = 255;

function pageParams(url: URL): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(url.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 本文件的管理员文案与默认值不同（对外更直白），故显式传入。 */
function adminSession(env: Env, request: Request) {
  return requireAdminSession(env, request, "需要管理员权限");
}

async function actorOf(session: { user: { email?: string; name?: string } }): Promise<string> {
  return session.user?.email || session.user?.name || "admin";
}

function blockedWhere(url: URL): { sql: string; values: string[] } {
  const active = url.searchParams.get("active");
  if (active === "true") return { sql: " WHERE active = 1", values: [] };
  if (active === "false") return { sql: " WHERE active = 0", values: [] };
  return { sql: "", values: [] };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await adminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  const url = new URL(context.request.url);
  const { page, pageSize, offset } = pageParams(url);
  const where = blockedWhere(url);
  const totalRows = await queryAll<{ n: number }>(
    context.env.DB,
    `SELECT COUNT(*) AS n FROM blocked_ips${where.sql}`,
    ...where.values,
  );
  const rows = await queryAll<BlockedRow>(
    context.env.DB,
    `SELECT cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active
     FROM blocked_ips${where.sql}
     ORDER BY updated_at DESC, cidr
     LIMIT ? OFFSET ?`,
    pageSize,
    offset,
  );
  return Response.json({
    ok: true,
    page,
    page_size: pageSize,
    total: totalRows[0]?.n ?? 0,
    items: rows,
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await adminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  if (!(await verifyCsrf(context.env, context.request, auth.session.sid))) {
    return Response.json({ error: "csrf_invalid" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const { session } = auth;
  const request = context.request;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const raw = (body as { cidr?: unknown })?.cidr;
  if (typeof raw !== "string") {
    return Response.json({ error: "cidr required" }, { status: 400 });
  }
  const parsed = parseCidr(raw);
  if (!parsed) {
    return Response.json({ error: "invalid cidr" }, { status: 400 });
  }
  // 理由必须限长：其余字符串字段都有 cap，这里以前没有，一个请求就能写入
  // 几百 KB。分页响应会被撑爆、500 MB 库容量被吃掉，而且审计行与变更在同一
  // 批次里，语句过大时连审计一起丢（等于变更没有留痕）。
  const rawReason =
    typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : "";
  const reason = rawReason.slice(0, BLOCKLIST_REASON_MAX_LENGTH);
  const actor = await actorOf(session);
  const now = "datetime('now')";
  const mutationSql =
    `INSERT INTO blocked_ips
       (cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active)
     VALUES (?, ?, ?, ?, 'admin/add', ${now}, ${now}, ?, 1)
     ON CONFLICT(cidr) DO UPDATE SET
       network = excluded.network, prefix = excluded.prefix, reason = excluded.reason,
       source = 'admin/add', updated_at = excluded.updated_at, updated_by = excluded.updated_by,
       active = 1`;
  const auditSql =
    `INSERT INTO blocklist_audit
       (cidr, network, prefix, action, actor, reason, source, previous_reason,
        previous_source, previous_updated_at, created_at)
     VALUES (?, ?, ?, 'add', ?, ?, 'admin/add', '', '', '', ${now})`;
  const ok = await writeAndAudit(
    context.env,
    mutationSql,
    [parsed.cidr, parsed.network, parsed.prefix, reason, actor],
    auditSql,
    [parsed.cidr, parsed.network, parsed.prefix, actor, reason],
  );
  if (!ok) {
    return Response.json({ error: "D1 write failed" }, { status: 500 });
  }
  await logEvent(context.env, "blocklist_change", request, {
    outcome: "success",
    status: 200,
    path: "blocklist",
    message: `add ${parsed.cidr} by ${actor}`,
  });
  return Response.json({ ok: true, cidr: parsed.cidr, action: "add" }, { status: 201 });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = await adminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  if (!(await verifyCsrf(context.env, context.request, auth.session.sid))) {
    return Response.json({ error: "csrf_invalid" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const { session } = auth;
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("cidr");
  if (!raw) {
    return Response.json({ error: "cidr required" }, { status: 400 });
  }
  const parsed = parseCidr(raw);
  if (!parsed) {
    return Response.json({ error: "invalid cidr" }, { status: 400 });
  }
  const rows = await queryAll<BlockedRow>(
    context.env.DB,
    `SELECT cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active
     FROM blocked_ips WHERE cidr = ?`,
    parsed.cidr,
  );
  if (!rows.length) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const row = rows[0];
  if (row.active === 0) {
    return Response.json({ ok: true, cidr: row.cidr, already_unblocked: true });
  }
  const actor = await actorOf(session);
  const request = context.request;
  const now = "datetime('now')";
  const mutationSql =
    `UPDATE blocked_ips
     SET active = 0, source = 'admin/unblock', updated_at = ${now}, updated_by = ?
     WHERE cidr = ?`;
  const auditSql =
    `INSERT INTO blocklist_audit
       (cidr, network, prefix, action, actor, reason, source, previous_reason,
        previous_source, previous_updated_at, created_at)
     VALUES (?, ?, ?, 'unblock', ?, ?, 'admin/unblock', ?, ?, ?, ${now})`;
  const ok = await writeAndAudit(
    context.env,
    mutationSql,
    [actor, parsed.cidr],
    auditSql,
    [parsed.cidr, parsed.network, parsed.prefix, actor, row.reason, row.reason, row.source, row.updated_at],
  );
  if (!ok) {
    return Response.json({ error: "D1 write failed" }, { status: 500 });
  }
  await logEvent(context.env, "blocklist_change", request, {
    outcome: "success",
    status: 200,
    path: "blocklist",
    message: `unblock ${parsed.cidr} by ${actor}`,
  });
  return Response.json({ ok: true, cidr: parsed.cidr, action: "unblock" });
};

async function writeAndAudit(
  env: Env,
  mutationSql: string,
  mutationValues: unknown[],
  auditSql: string,
  auditValues: unknown[],
): Promise<boolean> {
  if (env.DB?.batch) {
    const ok = await executeBatch(env.DB, [
      env.DB.prepare(mutationSql).bind(...mutationValues),
      env.DB.prepare(auditSql).bind(...auditValues),
    ]);
    // D1 batch 用于保持“封禁变更 + 审计”原子性；失败时不能降级为
    // 两次独立写入，否则可能出现无审计的线上变更。
    return ok;
  }
  const mutationOk = await execute(env.DB, mutationSql, ...mutationValues);
  if (!mutationOk) return false;
  return execute(env.DB, auditSql, ...auditValues);
}
