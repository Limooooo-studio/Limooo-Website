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
 * GET /logout → 撤销 D1 会话、清 cookie，再跳 Access 登出端点（docs/17 §11.6）。
 *
 * 两步缺一不可：
 * - 撤销 D1 `auth_sessions`：本系统侧的会话立即失效（requireAuth fail-closed）；
 * - 跳 Access 登出：清 Cloudflare 侧的 `CF_Authorization`，否则下一个请求会
 *   被 Access 用残留会话自动重新认证，「退出」看起来没生效。
 */

import { accessLogoutUrl, accessTeamDomain } from "./_lib/access";
import {
  clearPendingCookie,
  clearSessionCookie,
  configErrorResponse,
  readSession,
  revokeAuthSession,
  runtimeConfigError,
} from "./_lib/session";
import type { Env } from "./_lib/env";
import { logEvent } from "./_lib/logging";
import { safeNextUrl } from "./_lib/routing";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const configError = runtimeConfigError(env);
  if (configError) return configErrorResponse(configError);

  // `next` 会直接进 Location，必须与 /login 用同一个收口：只允许站内相对路径
  // 或白名单主机的 https 地址。否则 ACCESS_TEAM_DOMAIN 为空时（生产确实出现过，
  // 见 docs/17 §11.10）下面 `target = next` 的分支就是开放重定向；带 CR/LF 的
  // 非法值还会让 workerd 构造响应头时抛异常 → 500（docs/22 W9-3）。
  const next = safeNextUrl(url.searchParams.get("next"));
  const session = await readSession(env, request.headers.get("Cookie"));
  if (session?.sid) {
    const revoked = await revokeAuthSession(env, session.sid);
    if (!revoked) {
      await logEvent(env, "logout", request, {
        outcome: "failed",
        status: 503,
        message: "revoke_unavailable",
      });
      return configErrorResponse("auth_sessions_unavailable");
    }
  }

  await logEvent(env, "logout", request, {
    outcome: "ok",
    status: 302,
    message: session ? `sid=${session.sid.slice(0, 8)}` : "no_session",
  });

  // Access 未配置时退化为只跳 next，本地会话已经撤销，不影响安全性。
  const target = accessTeamDomain(env) ? accessLogoutUrl(env, next) : next;
  const resp = new Response(null, { status: 302, headers: { Location: target } });
  resp.headers.append("Set-Cookie", clearSessionCookie());
  resp.headers.append("Set-Cookie", clearPendingCookie());
  return resp;
};
