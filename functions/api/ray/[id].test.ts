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
vi.mock("../../_lib/session", async () => {
  // 共用桩（docs/22 W5-15）：语义与位置说明见 tests/helpers/admin-session.ts。
  const { createSessionModuleMock } = await import("../../../tests/helpers/admin-session");
  return createSessionModuleMock();
});

const env = {} as Env;

function context(id = "0123456789abcdef") {
  return {
    request: new Request(`https://visitor.limooo.cn/api/ray/${id}`),
    env,
    params: { id },
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

  // W5-15：撤销表不可用时必须 fail-closed（503），不能降级成放行或 401。
  it("fails closed with 503 when the session store is unavailable", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error("auth_sessions_unavailable"));
    const resp = await onRequestGet(context() as never);
    expect(resp.status).toBe(503);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
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

  // 线上实测（2026-10-11）：`LIKE '<id>%'` 让 D1 退化成 `SCAN … USING INDEX
  // idx_ray_log_v2_ts`（全表扫），而 `ray` 是 TEXT PRIMARY KEY —— 改写成主键范围后
  // 计划变成 `SEARCH … USING INDEX sqlite_autoindex_ray_log_v2_1 (ray>? AND ray<?)`。
  // 这条用例把那个形状钉住：改回 LIKE 就红。
  it("looks the ray up with a primary-key range, not a LIKE scan", async () => {
    await onRequestGet(context() as never);

    // queryAll(db, sql, ...values) —— 第一个参数是 D1 绑定，SQL 在第二个位置。
    const [, sql, ...bounds] = vi.mocked(queryAll).mock.calls[0] as [unknown, string, ...string[]];
    expect(sql).toContain("WHERE ray >= ? AND ray < ?");
    expect(sql).not.toMatch(/ray\s+LIKE/i);
    // 下界是 16 位十六进制 id；上界必须是"比任何后缀都大"的那个值，
    // 否则带 colo 后缀的落库值（`…-LAX`）会漏掉，或将来换后缀就查不到。
    expect(bounds[0]).toBe("0123456789abcdef");
    expect(bounds[1]).toBe("0123456789abcdef\u{10ffff}");
    expect(bounds[1]! > "0123456789abcdef-LAX").toBe(true);
  });

  it("matches a stored ray that carries a colo suffix", async () => {
    // 回归保护：落库值是 `a48923a17e543777-LAX`（20 字符），调用方只给 16 位十六进制。
    // 桩把"库里带后缀的那一行"返回，断言端点把它当成命中而不是空结果。
    vi.mocked(queryAll).mockResolvedValueOnce([{
      ray: "0123456789abcdef-LAX",
      ts: 7,
      host: "limooo.cn",
      path: "/x",
      method: "GET",
      status: 200,
      ip_hash: "h",
      ua_family: "chrome",
    }] as never);

    const resp = await onRequestGet(context("0123456789ABCDEF-LAX") as never);
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].ray).toBe("0123456789abcdef-LAX");
  });
});
