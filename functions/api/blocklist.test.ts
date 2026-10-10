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

/** /api/blocklist 管理 API 测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestDelete, onRequestGet, onRequestPost } from "./blocklist";
import { execute, executeBatch, queryAll } from "../_lib/d1";
import { logEvent } from "../_lib/logging";
import { requireAuth } from "../_lib/session";

vi.mock("../_lib/d1", () => ({
  queryAll: vi.fn(),
  execute: vi.fn(),
  executeBatch: vi.fn(),
}));
vi.mock("../_lib/logging", () => ({ logEvent: vi.fn() }));
vi.mock("../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(() => new Response("unavailable", { status: 503 })),
  // 与生产同策略：委托给桩化的 requireAuth，未登录 401、非 admin 403。
  requireAdminSession: vi.fn(async (env: unknown, request: Request, forbidden = "只读账户，无写入权限") => {
    const { requireAuth: mocked } = await import("../_lib/session");
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
vi.mock("../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
import { verifyCsrf } from "../_lib/csrf";

const env = {
  DB: { batch: undefined as (() => unknown) | undefined },
} as never;

function context(request: Request) {
  return {
    request,
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

function adminSession() {
  return {
    sid: "sid-1",
    sub: "sub-1",
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin" as const,
    authAt: 1,
    exp: 9999999999,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(adminSession());
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(executeBatch).mockResolvedValue(true);
  vi.mocked(verifyCsrf).mockResolvedValue(true);
});

describe("blocklist API", () => {
  it("returns paginated rows for admins", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([
        {
          cidr: "1.2.3.0/24",
          network: "1.2.3.0",
          prefix: 24,
          reason: "",
          source: "auto_block",
          created_at: "2026-08-27 00:00:00",
          updated_at: "2026-08-27 00:00:00",
          updated_by: "auto_block",
          active: 1,
        },
      ]);
    const resp = await onRequestGet(
      context(new Request("https://limooo.cn/api/blocklist?page=1&page_size=10")) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.total).toBe(1);
    expect(data.items[0].cidr).toBe("1.2.3.0/24");
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const resp = await onRequestGet(context(new Request("https://limooo.cn/api/blocklist")) as never);
    expect(resp.status).toBe(401);
  });

  it("adds a canonical cidr with audit", async () => {
    const resp = await onRequestPost(
      context(
        new Request("https://limooo.cn/api/blocklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cidr: "1.2.3.4", reason: "manual block" }),
        }),
      ) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(201);
    expect(data.cidr).toBe("1.2.3.4/32");
    expect(vi.mocked(execute)).toHaveBeenCalled();
    expect(vi.mocked(logEvent)).toHaveBeenCalled();
  });

  it("soft-deletes an active row with audit", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([
      {
        cidr: "1.2.3.0/24",
        network: "1.2.3.0",
        prefix: 24,
        reason: "old",
        source: "auto_block",
        created_at: "2026-08-27 00:00:00",
        updated_at: "2026-08-27 00:00:00",
        updated_by: "auto_block",
        active: 1,
      },
    ]);
    const resp = await onRequestDelete(
      context(new Request("https://limooo.cn/api/blocklist?cidr=1.2.3.0/24", {
        method: "DELETE",
        headers: { Origin: "https://limooo.cn" },
      })) as never,
    );
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.action).toBe("unblock");
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("UPDATE blocked_ips");
  });

  it("caps the stored reason so one request cannot write hundreds of KB", async () => {
    // 其余字符串字段都有 cap，reason 以前没有：可写入几百 KB/行，撑爆分页响应
    // 与 500 MB 库容量；审计行与变更在同一批次里，语句过大时连审计一起丢。
    const long = "x".repeat(5000);
    const resp = await onRequestPost(
      context(
        new Request("https://limooo.cn/api/blocklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cidr: "5.6.7.8", reason: long }),
        }),
      ) as never,
    );
    expect(resp.status).toBe(201);
    const mutation = vi.mocked(execute).mock.calls.find((call) =>
      String(call[1]).includes("INSERT INTO blocked_ips"),
    );
    expect(mutation).toBeTruthy();
    const bound = (mutation ?? []).slice(2) as unknown[];
    const reason = bound.find((value) => typeof value === "string" && value.startsWith("xxx"));
    expect(typeof reason).toBe("string");
    expect(String(reason).length).toBe(255);
    expect(String(reason)).toBe("x".repeat(255));
  });

  it("keeps a normal short reason intact", async () => {
    const resp = await onRequestPost(
      context(
        new Request("https://limooo.cn/api/blocklist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cidr: "5.6.7.8", reason: "manual block" }),
        }),
      ) as never,
    );
    expect(resp.status).toBe(201);
    const mutation = vi.mocked(execute).mock.calls.find((call) =>
      String(call[1]).includes("INSERT INTO blocked_ips"),
    );
    const bound = (mutation ?? []).slice(2) as unknown[];
    expect(bound[3]).toBe("manual block");
  });

  it("rejects mutating requests without CSRF", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    const resp = await onRequestPost(
      context(new Request("https://limooo.cn/api/blocklist", {
        method: "POST",
        body: JSON.stringify({ cidr: "1.2.3.4" }),
      })) as never,
    );
    expect(resp.status).toBe(403);
    expect(vi.mocked(execute)).not.toHaveBeenCalled();
  });
});
