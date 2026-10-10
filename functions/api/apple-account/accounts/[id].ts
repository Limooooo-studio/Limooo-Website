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

/** PUT /api/apple-account/accounts/:id（更新） / DELETE（删除，需 admin + CSRF） */

import { queryAll, execute } from "../../../_lib/d1";
import { fernetEncrypt } from "../../../_lib/fernet";
import { requireAdminSession } from "../../../_lib/session";
import { verifyCsrf } from "../../../_lib/csrf";
import { parseAccountId, validateUpdatePayload } from "../../../_lib/apple-account";
import { describeWriteError, isUniqueConflict } from "../../../_lib/apple-account-errors";
import { logEvent } from "../../../_lib/logging";
import type { Env } from "../../../_lib/env";

const NO_STORE = { "Cache-Control": "no-store" };

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const auth = await requireAdminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  const id = parseAccountId((context.params as { id?: string }).id);
  if (!id) return Response.json({ error: "无效请求" }, { status: 400, headers: NO_STORE });
  if (!(await verifyCsrf(context.env, context.request, auth.session.sid))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: NO_STORE });
  }

  let data: unknown;
  try {
    data = await context.request.json();
  } catch {
    return Response.json({ error: "无效请求" }, { status: 400, headers: NO_STORE });
  }
  const parsed = validateUpdatePayload(data);
  if (!parsed) return Response.json({ error: "无效请求" }, { status: 400, headers: NO_STORE });

  let password = "";
  if (parsed.passwordChanged) {
    if (!context.env.APPLE_ACCOUNT_ENCRYPTION_KEY) {
      return Response.json({ error: "服务器未配置加密密钥" }, { status: 500, headers: NO_STORE });
    }
    password = await fernetEncrypt(parsed.password ?? "", context.env.APPLE_ACCOUNT_ENCRYPTION_KEY);
  } else {
    const existing = await queryAll<{ password: string }>(
      context.env.DB,
      "SELECT password FROM apple_accounts WHERE id = ?",
      id,
    );
    if (!existing.length) {
      await logEvent(context.env, "audit_event", context.request, {
        outcome: "account_update_not_found",
        status: 404,
        accountId: id,
        actorSub: auth.session.sub,
        message: "apple_account_missing",
      });
      return Response.json({ error: "未找到" }, { status: 404, headers: NO_STORE });
    }
    password = existing[0].password;
  }

  let ok = false;
  try {
    ok = await execute(
      context.env.DB,
      "UPDATE apple_accounts SET email = ?, password = ?, notes = ?, updated_at = datetime('now') WHERE id = ?",
      parsed.email,
      password,
      parsed.notes,
      id,
    );
  } catch (err) {
    // 同 POST：只有真正的 UNIQUE 冲突才是 409（docs/22 W9-6）。
    const conflict = isUniqueConflict(err);
    await logEvent(context.env, "audit_event", context.request, {
      outcome: conflict ? "account_update_conflict" : "account_update_failed",
      status: conflict ? 409 : 500,
      accountId: id,
      actorSub: auth.session.sub,
      message: conflict ? "apple_account_duplicate_email" : describeWriteError(err),
    });
    if (conflict) {
      return Response.json({ error: "该邮箱已存在" }, { status: 409, headers: NO_STORE });
    }
    return Response.json({ error: "写入失败" }, { status: 500, headers: NO_STORE });
  }
  // 审计里只记「改了什么口令状态」，绝不记口令本身或密文。
  await logEvent(context.env, "audit_event", context.request, {
    outcome: ok ? "account_updated" : "account_update_missing",
    status: ok ? 200 : 404,
    accountId: id,
    actorSub: auth.session.sub,
    message: parsed.passwordChanged ? "password_changed" : "metadata_only",
  });
  return Response.json({ status: ok ? "ok" : "not found" }, { status: ok ? 200 : 404, headers: NO_STORE });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const auth = await requireAdminSession(context.env, context.request);
  if (auth instanceof Response) return auth;
  const id = parseAccountId((context.params as { id?: string }).id);
  if (!id) return Response.json({ error: "无效请求" }, { status: 400, headers: NO_STORE });
  if (!(await verifyCsrf(context.env, context.request, auth.session.sid))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: NO_STORE });
  }
  const existing = await queryAll<{ id: number }>(context.env.DB, "SELECT id FROM apple_accounts WHERE id = ?", id);
  if (!existing.length) {
    await logEvent(context.env, "audit_event", context.request, {
      outcome: "account_delete_not_found",
      status: 404,
      accountId: id,
      actorSub: auth.session.sub,
      message: "apple_account_missing",
    });
    return Response.json({ error: "未找到" }, { status: 404, headers: NO_STORE });
  }
  let ok = false;
  try {
    ok = await execute(context.env.DB, "DELETE FROM apple_accounts WHERE id = ?", id);
  } catch (err) {
    await logEvent(context.env, "audit_event", context.request, {
      outcome: "account_delete_failed",
      status: 500,
      accountId: id,
      actorSub: auth.session.sub,
      message: describeWriteError(err),
    });
    return Response.json({ error: "删除失败" }, { status: 500, headers: NO_STORE });
  }
  await logEvent(context.env, "audit_event", context.request, {
    outcome: ok ? "account_deleted" : "account_delete_missing",
    status: ok ? 200 : 404,
    accountId: id,
    actorSub: auth.session.sub,
    message: "apple_account_delete",
  });
  return Response.json({ status: ok ? "ok" : "not found" }, { status: ok ? 200 : 404, headers: NO_STORE });
};
