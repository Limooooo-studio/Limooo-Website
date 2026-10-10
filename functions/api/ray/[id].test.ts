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

/** Ray API 权限与最小字段测试。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./[id]";
import { queryAll } from "../../_lib/d1";
import { requireAuth } from "../../_lib/session";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(() => new Response("unavailable", { status: 503 })),
  // 与生产同策略：委托给桩化的 requireAuth，未登录 401、非 admin 403。
  requireAdminSession: vi.fn(async (env: unknown, request: Request, forbidden = "只读账户，无写入权限") => {
    const { requireAuth: mocked } = await import("../../_lib/session");
    const session = await (mocked as (...a: unknown[]) => Promise<unknown>)(env, request);
    if (!session) {
      return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if ((session as { role?: string }).role !== "admin") {
      return Response.json({ error: forbidden }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return { session };
  }),
}));

const env = {} as Env;

function context() {
  return {
    request: new Request("https://visitor.limooo.cn/api/ray/0123456789abcdef"),
    env,
    params: { id: "0123456789abcdef" },
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    sid: "sid-1",
    sub: "user-1",
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    authAt: 1,
  } as never);
  vi.mocked(queryAll).mockResolvedValue([{
    ray: "0123456789abcdef-ABC",
    ts: 1,
    host: "limooo.cn",
    path: "/",
    method: "GET",
    status: 200,
    ip_hash: "abc123",
    ua_family: "chrome",
    ip: "1.2.3.4",
    ua: "full-user-agent",
    country: "US",
  }] as never);
});

describe("ray API", () => {
  it("requires an admin session", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    expect((await onRequestGet(context() as never)).status).toBe(401);
    vi.mocked(requireAuth).mockResolvedValue({
      sid: "sid-1",
      sub: "user-1",
      user: { email: "viewer@example.com", name: "Viewer" },
      role: "viewer",
      authAt: 1,
    } as never);
    expect((await onRequestGet(context() as never)).status).toBe(403);
  });

  it("returns only minimal fields and no-store headers", async () => {
    const resp = await onRequestGet(context() as never);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.rows[0]).toMatchObject({
      ray: "0123456789abcdef-ABC",
      ip_hash: "abc123",
      ua_family: "chrome",
      method: "GET",
      status: 200,
    });
    expect(data.rows[0]).not.toHaveProperty("ip");
    expect(data.rows[0]).not.toHaveProperty("ua");
    expect(data.rows[0]).not.toHaveProperty("country");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});
