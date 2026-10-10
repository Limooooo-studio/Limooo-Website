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

/** PUT /api/apple-account/reorder（需 admin + CSRF；D1 batch 事务，失败不部分生效） */

import { executeBatch, queryAll } from "../../_lib/d1";
import { requireAdminSession } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
import { logEvent } from "../../_lib/logging";
import { validateOrder } from "../../_lib/apple-account";
import type { Env } from "../../_lib/env";

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = await requireAdminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  if (!(await verifyCsrf(context.env, context.request, auth.session.sid))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  let data: unknown;
  try {
    data = await context.request.json();
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const order = validateOrder(data);
  if (!order) return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const existing = await queryAll<{ id: number }>(context.env.DB, "SELECT id FROM apple_accounts");
  const ids = new Set(existing.map((r) => r.id));
  if (!order.every((id) => ids.has(id))) {
    return Response.json({ error: "包含不存在的账号" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // 必须要求提交的集合与库里的集合**完全一致**：只校验「提交的 id 都存在」时，
  // 未提交的行会保留旧 sort_order，与提交行产生重复值，排序语义变模糊
  // （谁在前取决于 D1 的行顺序）。
  if (order.length !== ids.size) {
    return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const statements = order
    .map((id, index) =>
      context.env.DB?.prepare("UPDATE apple_accounts SET sort_order = ? WHERE id = ?").bind(index, id),
    )
    .filter((statement): statement is NonNullable<typeof statement> => Boolean(statement));
  if (!(await executeBatch(context.env.DB, statements))) {
    await logEvent(context.env, "audit_event", context.request, {
      outcome: "accounts_reorder_failed",
      status: 500,
      actorSub: auth.session.sub,
      message: "apple_account_reorder_batch_failed",
    });
    return Response.json({ error: "排序失败" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  // 只记「谁改了顺序」；顺序本身能从账号列表复现，不必进审计行。
  await logEvent(context.env, "audit_event", context.request, {
    outcome: "accounts_reordered",
    status: 200,
    actorSub: auth.session.sub,
    message: `count=${order.length}`,
  });
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
};
