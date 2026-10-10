/** POST /api/apple-account/accounts/:id/reveal（admin + 近期认证 + CSRF，返回后审计并立即丢弃） */

import { queryAll } from "../../../../_lib/d1";
import { fernetDecrypt } from "../../../../_lib/fernet";
import { requireRecentAdminSession } from "../../../../_lib/session";
import { verifyCsrf } from "../../../../_lib/csrf";
import { parseAccountId } from "../../../../_lib/apple-account";
import { logEvent } from "../../../../_lib/logging";
import type { Env } from "../../../../_lib/env";

/**
 * 顺序：鉴权 + 近期认证（`requireRecentAdminSession`）→ CSRF → 取数据。
 *
 * 会话在 CSRF 之前才能拿到，token 要绑定 `sid`；而「近期认证」是 401 /
 * 非 admin 是 403 / CSRF 失败是 403，三种拒绝的顺序因此固定为
 * 鉴权 → 近期认证 → CSRF（docs/21 T2/T4）。
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = await requireRecentAdminSession(context.env, context.request);
  if (auth instanceof Response) {
    // 近期认证超时也留一条审计：谁在什么时候试图解密明文密码。
    if (auth.status === 401) {
      await logEvent(context.env, "audit_event", context.request, {
        outcome: "reauth_required",
        status: 401,
        message: "password_reveal_reauth_required",
      });
    }
    return auth;
  }
  const { session } = auth;
  if (!(await verifyCsrf(context.env, context.request, session.sid))) {
    return Response.json({ error: "无权限" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const id = parseAccountId((context.params as { id?: string }).id);
  if (!id) return Response.json({ error: "无效请求" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const rows = await queryAll<{ password: string }>(
    context.env.DB,
    "SELECT password FROM apple_accounts WHERE id = ?",
    id,
  );
  if (!rows.length) return Response.json({ error: "未找到" }, { status: 404, headers: { "Cache-Control": "no-store" } });

  let plain = "";
  try {
    if (!context.env.APPLE_ACCOUNT_ENCRYPTION_KEY) throw new Error("missing encryption key");
    plain = await fernetDecrypt(rows[0].password, context.env.APPLE_ACCOUNT_ENCRYPTION_KEY);
  } catch {
    await logEvent(context.env, "audit_event", context.request, {
      outcome: "decrypt_failed",
      status: 500,
      accountId: id,
      actorSub: session.sub,
      message: "password_reveal_failed",
    });
    return Response.json(
      { error: "解密失败，已记录审计事件" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  await logEvent(context.env, "audit_event", context.request, {
    outcome: "password_revealed",
    status: 200,
    accountId: id,
    actorSub: session.sub,
    message: "password_reveal",
  });
  return Response.json({ password: plain }, { headers: { "Cache-Control": "no-store" } });
};
