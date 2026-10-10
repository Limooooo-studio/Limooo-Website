/** PUT /api/apple-account/reorder（需 admin + CSRF；D1 batch 事务，失败不部分生效） */

import { executeBatch, queryAll } from "../../_lib/d1";
import { requireAdminSession } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
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

  const statements = order
    .map((id, index) =>
      context.env.DB?.prepare("UPDATE apple_accounts SET sort_order = ? WHERE id = ?").bind(index, id),
    )
    .filter((statement): statement is NonNullable<typeof statement> => Boolean(statement));
  if (!(await executeBatch(context.env.DB, statements))) {
    return Response.json({ error: "排序失败" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
};
