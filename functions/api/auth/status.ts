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

/** GET /api/auth/status（已登录时签发 CSRF 双提交 token） */

import { createCsrfToken, csrfCookieHeader } from "../../_lib/csrf";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth(context.env, context.request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) {
    return Response.json(
      { authed: false, user: null, role: "viewer" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  let token: string;
  try {
    ({ token } = await createCsrfToken(context.env, session.sid));
  } catch {
    return Response.json(
      { error: "csrf_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.set("X-CSRF-Token", token);
  headers.set(
    "Set-Cookie",
    csrfCookieHeader(token, new URL(context.request.url).protocol === "https:"),
  );
  return new Response(
    JSON.stringify({
      authed: true,
      user: session.user,
      role: session.role,
      csrf_token: token,
    }),
    { headers },
  );
};
