/** HMAC 会话 cookie + D1 会话撤销表单元测试 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { execute, queryAll } from "./d1";
import {
  ADMIN_REQUIRED_MESSAGE,
  AuthSessionUnavailableError,
  REAUTH_REQUIRED_MESSAGE,
  configErrorResponse,
  createAuthSession,
  createSessionCookie,
  readSession,
  requireAdminSession,
  requireAuth,
  requireRecentAdminSession,
  revokeAuthSession,
  runtimeConfigError,
} from "./session";

vi.mock("./d1", () => ({
  execute: vi.fn(),
  queryAll: vi.fn(),
}));

const env: Env = {
  DB: {},
  SESSION_HMAC_KEY: "test-session-hmac-key",
} as Env;

function sessionData(prefix = ""): any {
  return {
    sid: `${prefix}sid-1`,
    sub: "user-1",
    user: { email: "a@example.com", name: "A" },
    role: "admin",
    authAt: 1,
  };
}

function requestWith(cookie: string): Request {
  return new Request("https://visitor.limooo.cn/api", {
    headers: { Cookie: cookie },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(queryAll).mockResolvedValue([]);
});

describe("session cookie", () => {
  it("round-trips a valid session with sid and cross-subdomain domain", async () => {
    const header = await createSessionCookie(env, sessionData());
    expect(header).toContain("Domain=.limooo.cn");
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    const session = await readSession(env, header);
    expect(session?.sid).toBe("sid-1");
    expect(session?.sub).toBe("user-1");
    expect(session?.role).toBe("admin");
  });

  it("rejects tampered tokens", async () => {
    const header = await createSessionCookie(env, sessionData());
    const dot = header.lastIndexOf(".");
    const originalPayload = header.slice(header.indexOf("=") + 1, dot);
    const decoded = Buffer.from(originalPayload, "base64url").toString();
    const tamperedPayload = Buffer.from(decoded.replace("user-1", "user-2")).toString("base64url");
    const tampered = header.replace(originalPayload, tamperedPayload);
    expect(await readSession(env, tampered)).toBeNull();
  });

  it("rejects malformed session payloads", async () => {
    const header = await createSessionCookie(env, sessionData());
    const dot = header.lastIndexOf(".");
    const originalPayload = header.slice(header.indexOf("=") + 1, dot);
    const decoded = Buffer.from(originalPayload, "base64url").toString();
    const badPayload = Buffer.from(decoded.replace('"sid":"sid-1"', '"sid":""')).toString("base64url");
    const tampered = header.replace(originalPayload, badPayload);
    expect(await readSession(env, tampered)).toBeNull();
  });

  it("rejects a cookie with malformed percent encoding", async () => {
    await expect(readSession(env, "limooo_session=%" as string)).resolves.toBeNull();
  });
});

describe("auth_sessions revoke table", () => {
  it("checks the D1 record before allowing requireAuth", async () => {
    const header = await createSessionCookie(env, sessionData());
    vi.mocked(queryAll).mockResolvedValue([{
      sid: "sid-1",
      sub: "user-1",
      role: "admin",
      auth_at: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
      revoked_at: null,
    }]);
    const session = await requireAuth(env, requestWith(header));
    expect(session?.sid).toBe("sid-1");
    expect(vi.mocked(queryAll).mock.calls[0][1]).toContain("FROM auth_sessions");
  });

  it("does not allow a revoked session", async () => {
    const header = await createSessionCookie(env, sessionData());
    vi.mocked(queryAll).mockResolvedValue([{
      sid: "sid-1",
      sub: "user-1",
      role: "admin",
      auth_at: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
      revoked_at: 123,
    }]);
    const session = await requireAuth(env, requestWith(header));
    expect(session).toBeNull();
  });

  it("throws AuthSessionUnavailableError when D1 is unavailable", async () => {
    const header = await createSessionCookie(env, sessionData());
    await expect(requireAuth({ SESSION_HMAC_KEY: env.SESSION_HMAC_KEY } as Env, requestWith(header)))
      .rejects.toBeInstanceOf(AuthSessionUnavailableError);
  });

  it("creates and revokes sessions", async () => {
    expect(await createAuthSession(env, sessionData())).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("INSERT INTO auth_sessions");

    vi.mocked(execute).mockClear();
    expect(await revokeAuthSession(env, "sid-1")).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("SET revoked_at = unixepoch()");
  });
});

describe("runtime config", () => {
  it("returns a config error for missing secrets", () => {
    expect(runtimeConfigError({} as Env)).toContain("TURNSTILE_SECRET");
    expect(runtimeConfigError({
      TURNSTILE_SECRET: "x",
      GATE_HMAC_KEY: "x",
      SESSION_HMAC_KEY: "x",
    } as Env)).toBeNull();
  });

  it("renders a no-store 503 config page", () => {
    const resp = configErrorResponse("missing_SESSION_HMAC_KEY");
    expect(resp.status).toBe(503);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });
});

/**
 * requireAdminSession 是所有管理端点的鉴权收口（原先 8 处各抄一份），
 * 401 / 403 / 503 三种拒绝语义与 no-store 头在此集中验证。
 *
 * requireAdminSession 走的是模块内 requireAuth 绑定，无法用 spyOn 替换，
 * 因此这里签发真实 cookie + 桩化 D1 撤销表，跑的是完整校验链路。
 */
describe("requireAdminSession", () => {
  async function cookieFor(role: "admin" | "viewer"): Promise<Request> {
    const cookie = await createSessionCookie(env, { ...sessionData(), role });
    return requestWith(cookie.split(";")[0]);
  }

  /** requireAuth 需在 D1 撤销表里确认会话仍有效。 */
  function grantRow(role: "admin" | "viewer"): void {
    vi.mocked(queryAll).mockResolvedValue([
      { sid: "sid-1", sub: "user-1", role, auth_at: 1, exp: 9_999_999_999, revoked_at: null },
    ]);
  }

  it("returns the session for an admin", async () => {
    grantRow("admin");
    const result = await requireAdminSession(env, await cookieFor("admin"));
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { session: { role: string } }).session.role).toBe("admin");
  });

  it("returns 401 with no-store when there is no session", async () => {
    const resp = (await requireAdminSession(env, requestWith(""))) as Response;
    expect(resp.status).toBe(401);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect((await resp.json() as { error: string }).error).toBe("未登录");
  });

  it("returns 403 with the default message for a non-admin", async () => {
    grantRow("viewer");
    const resp = (await requireAdminSession(env, await cookieFor("viewer"))) as Response;
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect((await resp.json() as { error: string }).error).toBe(ADMIN_REQUIRED_MESSAGE);
  });

  it("honours a caller-supplied forbidden message", async () => {
    grantRow("viewer");
    const resp = (await requireAdminSession(env, await cookieFor("viewer"), "需要管理员权限")) as Response;
    expect(resp.status).toBe(403);
    expect((await resp.json() as { error: string }).error).toBe("需要管理员权限");
  });

  it("returns 503 when the session store is unavailable", async () => {
    vi.mocked(queryAll).mockRejectedValue(new Error("d1 down"));
    const resp = (await requireAdminSession(env, await cookieFor("admin"))) as Response;
    expect(resp.status).toBe(503);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });
});

/**
 * requireRecentAdminSession：明文密码查看的 step-up 闸门（docs/21 T2）。
 *
 * 判定顺序与 requireAdminSession 一致（鉴权 → 非 admin 403 → 近期认证 401），
 * 所以这里同时验证“顺序不倒退”：viewer 即使 authAt 很新也还是 403，
 * 未登录还是 401「未登录」而不是 reauth。
 */
describe("requireRecentAdminSession", () => {
  const NOW_SECONDS = 1_800_000_000;

  async function cookieWithAge(ageSeconds: number, role: "admin" | "viewer" = "admin"): Promise<Request> {
    const cookie = await createSessionCookie(env, {
      ...sessionData(),
      role,
      authAt: NOW_SECONDS - ageSeconds,
    });
    return requestWith(cookie.split(";")[0]);
  }

  function grantRow(role: "admin" | "viewer"): void {
    vi.mocked(queryAll).mockResolvedValue([
      {
        sid: "sid-1",
        sub: "user-1",
        role,
        auth_at: NOW_SECONDS,
        exp: 9_999_999_999,
        revoked_at: null,
      },
    ]);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows an admin whose authAt is inside the window", async () => {
    grantRow("admin");
    const result = await requireRecentAdminSession(env, await cookieWithAge(0));
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { session: { sid: string } }).session.sid).toBe("sid-1");
  });

  it("allows an admin exactly at the window boundary (600s)", async () => {
    grantRow("admin");
    const result = await requireRecentAdminSession(env, await cookieWithAge(600));
    expect(result).not.toBeInstanceOf(Response);
  });

  it("returns 401 reauth:true with no-store once the window has passed", async () => {
    grantRow("admin");
    const resp = (await requireRecentAdminSession(env, await cookieWithAge(601))) as Response;
    expect(resp.status).toBe(401);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(await resp.json()).toEqual({ error: REAUTH_REQUIRED_MESSAGE, reauth: true });
  });

  it("honours an explicit maxAge override", async () => {
    grantRow("admin");
    const req = await cookieWithAge(120);
    expect(await requireRecentAdminSession(env, req, 60)).toBeInstanceOf(Response);
    expect(await requireRecentAdminSession(env, req, 300)).not.toBeInstanceOf(Response);
  });

  it("keeps 401 for no session and 403 for a fresh viewer (order unchanged)", async () => {
    const anon = (await requireRecentAdminSession(env, requestWith(""))) as Response;
    expect(anon.status).toBe(401);
    expect((await anon.json() as { error: string }).error).toBe("未登录");

    grantRow("viewer");
    const viewer = (await requireRecentAdminSession(env, await cookieWithAge(0, "viewer"))) as Response;
    expect(viewer.status).toBe(403);
    expect((await viewer.json() as { error: string }).error).toBe(ADMIN_REQUIRED_MESSAGE);
  });

  it("returns 503 when the session store is unavailable", async () => {
    vi.mocked(queryAll).mockRejectedValue(new Error("d1 down"));
    const resp = (await requireRecentAdminSession(env, await cookieWithAge(0))) as Response;
    expect(resp.status).toBe(503);
  });

  it("rejects a future authAt instead of letting a negative age pass", async () => {
    // `age = now - authAt` 只判上界时负数永远通过。今天不可利用（authAt 有签名），
    // 但这是守护「明文密码查看」的唯一一道门，方向必须封闭。
    grantRow("admin");
    for (const age of [-1, -3600]) {
      const resp = (await requireRecentAdminSession(env, await cookieWithAge(age))) as Response;
      expect(resp.status, `authAt ${-age}s in the future`).toBe(401);
      expect(await resp.json()).toEqual({ error: REAUTH_REQUIRED_MESSAGE, reauth: true });
    }
  });

  it("still allows the exact boundary once the future guard is in place", async () => {
    grantRow("admin");
    const resp = await requireRecentAdminSession(env, await cookieWithAge(600));
    expect(resp).not.toBeInstanceOf(Response);
  });
});
