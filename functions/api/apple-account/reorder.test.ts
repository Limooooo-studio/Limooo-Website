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

/** 排序接口测试：admin、CSRF、输入集合校验、D1 batch 原子性。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPut } from "./reorder";
import { executeBatch, queryAll } from "../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../_lib/session";
import { verifyCsrf } from "../../_lib/csrf";
import { logEvent } from "../../_lib/logging";
import type { Env } from "../../_lib/env";

vi.mock("../../_lib/d1", () => ({ queryAll: vi.fn(), executeBatch: vi.fn() }));
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
vi.mock("../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
vi.mock("../../_lib/logging", () => ({ logEvent: vi.fn() }));

const prepared = {
  bind: vi.fn(() => prepared),
  run: vi.fn(),
  all: vi.fn(),
} as never;
const db = {
  prepare: vi.fn(() => prepared),
  batch: vi.fn(async () => [{ success: true }]),
} as never;
const env = { DB: db } as Env;

function context(body: unknown) {
  return {
    request: new Request("https://account.limooo.cn/api/apple-account/reorder", {
      method: "PUT",
      headers: {
        Origin: "https://account.limooo.cn",
        "X-CSRF-Token": "valid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    params: {},
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
  vi.mocked(authUnavailableResponse).mockReturnValue(
    Response.json({ error: "auth_sessions_unavailable" }, { status: 503 }),
  );
  vi.mocked(verifyCsrf).mockResolvedValue(true);
  vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
  vi.mocked(executeBatch).mockResolvedValue(true);
});

describe("apple-account reorder API", () => {
  it("updates all ids in one batch", async () => {
    const resp = await onRequestPut(context({ order: [2, 1] }) as never);
    expect(resp.status).toBe(200);
    expect(vi.mocked(executeBatch)).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate, unknown, or malformed order arrays", async () => {
    expect((await onRequestPut(context({ order: [1, 1] }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: [3] }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: "bad" }) as never)).status).toBe(400);
    expect((await onRequestPut(context({ order: [1, 2], extra: 1 }) as never)).status).toBe(400);
  });

  it("rejects a partial order so no two rows can share one sort_order", async () => {
    // 只校验「提交的 id 都存在」时，未提交的行保留旧 sort_order，与提交行产生
    // 重复值，排序语义变模糊。必须要求提交的集合与库里的集合**完全一致**。
    vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const resp = await onRequestPut(context({ order: [1] }) as never);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toMatchObject({ error: "无效请求" });
    expect(vi.mocked(executeBatch)).not.toHaveBeenCalled();
  });

  it("rejects an order that is a superset of the account ids", async () => {
    vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
    expect((await onRequestPut(context({ order: [1, 2, 3] }) as never)).status).toBe(400);
  });

  it("still ignores the CSRF result on a partial order (validation first)", async () => {
    vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    const resp = await onRequestPut(context({ order: [1] }) as never);
    expect([400, 403]).toContain(resp.status);
  });

  it("returns 403 when CSRF is invalid", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    // 提交完整的 2 个 id，确保 403 来自 CSRF 而不是集合校验。
    expect((await onRequestPut(context({ order: [1, 2] }) as never)).status).toBe(403);
  });

  /** W9-4：排序改的是展示顺序，也属账号变更，必须留审计。 */
  it("audits a successful reorder and a failed reorder", async () => {
    vi.mocked(queryAll).mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const ok = await onRequestPut(context({ order: [2, 1] }) as never);
    expect(ok.status).toBe(200);
    const audit = vi.mocked(logEvent).mock.calls.find((call) => call[1] === "audit_event");
    expect((audit?.[3] as { outcome?: string })?.outcome).toBe("accounts_reordered");
    expect((audit?.[3] as { actorSub?: string })?.actorSub).toBe("user-1");

    vi.mocked(logEvent).mockClear();
    vi.mocked(executeBatch).mockResolvedValue(false);
    const failed = await onRequestPut(context({ order: [2, 1] }) as never);
    expect(failed.status).toBe(500);
    const failedAudit = vi.mocked(logEvent).mock.calls.find((call) => call[1] === "audit_event");
    expect((failedAudit?.[3] as { outcome?: string })?.outcome).toBe("accounts_reorder_failed");
  });
});
