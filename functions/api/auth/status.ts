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
