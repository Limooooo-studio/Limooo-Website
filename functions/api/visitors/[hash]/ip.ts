/**
 * GET /api/visitors/<ip_hash>/ip
 *
 * admin-only：解密**单个**访客行的完整 IP，供前端点击访客行后跳 ipinfo.io。
 *
 * 为什么单独开一个端点而不是塞进 /api/visitors 列表：
 * - 列表每次轮询最多 500 行，把 500 个密文全解一遍纯属浪费（还容易顶到
 *   Workers 免费版 10ms CPU 上限）；
 * - 完整 IP 只在用户明确要看某一行时才离开 Worker，列表响应里始终只有哈希。
 *
 * 索引：visitor_rollups 的 (ip_hash, last_ts) 索引让这次查询只读 1 行
 * （见 ops/migrations/014_visitor_ip_enc.sql）。
 */

import { queryAll } from "../../../_lib/d1";
import { requireAdminSession } from "../../../_lib/session";
import { decryptVisitorIp, visitorIpKey } from "../../../_lib/visitor-ip";
import { logEvent } from "../../../_lib/logging";
import type { Env } from "../../../_lib/env";

/** ip_hash 是 HMAC-SHA256 的前 16 位十六进制（见 _lib/logging.ts ipHash）。 */
const IP_HASH_RE = /^[0-9a-f]{16}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = await requireAdminSession(context.env, context.request, "无权限");
  if (auth instanceof Response) return auth;
  const actorSub = auth.session.sub;

  const hash = String(context.params?.hash ?? "");
  if (!IP_HASH_RE.test(hash)) return json({ error: "无效的访客标识" }, 400);

  /**
   * 每一次「把某个访客的明文 IP 拿出来」都留一行审计（docs/22 W9-4）。
   *
   * 同类的密码查看（`apple-account/accounts/[id]/reveal.ts`）一直有审计行，
   * 这里此前一条都没有：谁在什么时候看了哪个访客的真实 IP 无从追溯。
   * 审计里只放哈希与 actor，**绝不放明文 IP**——否则等于把明文又抄一份进 events。
   */
  const audit = (outcome: string, status: number, message: string): Promise<void> =>
    logEvent(context.env, "audit_event", context.request, {
      outcome,
      status,
      actorSub,
      message: `${message} hash=${hash}`,
    });

  if (!visitorIpKey(context.env)) {
    await audit("visitor_ip_unavailable", 503, "visitor_ip_key_missing");
    return json({ error: "ip_unavailable" }, 503);
  }

  const rows = await queryAll<{ ip_enc: string }>(
    context.env.DB,
    `SELECT ip_enc
       FROM visitor_rollups
      WHERE ip_hash = ? AND ip_enc != ''
      ORDER BY last_ts DESC
      LIMIT 1`,
    hash,
  );
  const token = rows[0]?.ip_enc ?? "";
  if (!token) {
    await audit("visitor_ip_missing", 404, "visitor_ip_not_stored");
    return json({ error: "ip_unavailable" }, 404);
  }

  const ip = await decryptVisitorIp(token, context.env);
  if (!ip) {
    console.error(JSON.stringify({ event: "visitor_ip_decrypt_error", hash }));
    await audit("visitor_ip_decrypt_failed", 500, "visitor_ip_decrypt_failed");
    return json({ error: "ip_unavailable" }, 500);
  }

  await audit("visitor_ip_revealed", 200, "visitor_ip_revealed");
  return json({ ip });
};
