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

/** Apple Account 更新/删除接口测试（mock 所有外部依赖）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestDelete, onRequestPut } from "./[id]";
import { execute, queryAll } from "../../../_lib/d1";
import { authUnavailableResponse, requireAuth } from "../../../_lib/session";
import { verifyCsrf } from "../../../_lib/csrf";
import { fernetEncrypt } from "../../../_lib/fernet";
import { logEvent } from "../../../_lib/logging";
import type { Env } from "../../../_lib/env";

vi.mock("../../../_lib/d1", () => ({ queryAll: vi.fn(), execute: vi.fn() }));
vi.mock("../../../_lib/session", () => ({
  requireAuth: vi.fn(),
  authUnavailableResponse: vi.fn(() => new Response("unavailable", { status: 503 })),
  // 与生产同策略：委托给桩化的 requireAuth，未登录 401、非 admin 403。
  requireAdminSession: vi.fn(async (env: unknown, request: Request, forbidden = "只读账户，无写入权限") => {
    const { requireAuth: mocked } = await import("../../../_lib/session");
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
vi.mock("../../../_lib/csrf", () => ({ verifyCsrf: vi.fn() }));
vi.mock("../../../_lib/fernet", () => ({ fernetEncrypt: vi.fn() }));
vi.mock("../../../_lib/logging", () => ({ logEvent: vi.fn() }));

const env = { APPLE_ACCOUNT_ENCRYPTION_KEY: "test-key" } as Env;

function context(request: Request) {
  return {
    request,
    env,
    params: { id: "1" },
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
  vi.mocked(fernetEncrypt).mockResolvedValue("encrypted");
  // mockReset 而不是只 clear：clearAllMocks 不会清掉 "Once" 队列，
  // 上一条用例遗留的 mockRejectedValueOnce 会串到下一条
  // （表现为「本该 500 的用例拿到 404」）。
  vi.mocked(execute).mockReset();
  vi.mocked(execute).mockResolvedValue(true);
  vi.mocked(queryAll).mockReset();
  vi.mocked(queryAll).mockResolvedValue([{ id: 1 }]);
});

function request(method: string, body?: unknown): Request {
  return new Request("https://account.limooo.cn/api/apple-account/accounts/1", {
    method,
    headers: {
      Origin: "https://account.limooo.cn",
      "X-CSRF-Token": "valid",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("apple-account account id API", () => {
  it("updates an account with CSRF and returns 404 for missing rows", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([{ password: "old-cipher" }]);
    const ok = await onRequestPut(
      context(request("PUT", {
        email: "alice@account.limooo.cn",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(ok.status).toBe(200);

    vi.mocked(queryAll).mockResolvedValueOnce([]);
    const missing = await onRequestPut(
      context(request("PUT", {
        email: "alice@account.limooo.cn",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(missing.status).toBe(404);
  });

  it("rejects a CSRF failure and invalid id", async () => {
    vi.mocked(verifyCsrf).mockResolvedValue(false);
    const csrf = await onRequestPut(
      context(request("PUT", {
        email: "alice",
        password: "",
        notes: "",
        password_changed: false,
      })) as never,
    );
    expect(csrf.status).toBe(403);

    vi.mocked(verifyCsrf).mockResolvedValue(true);
    const badId = await onRequestDelete(
      {
        request: request("DELETE"),
        env,
        params: { id: "-1" },
        next: async () => new Response("next"),
        waitUntil: vi.fn(),
      } as never,
    );
    expect(badId.status).toBe(400);
  });

  it("deletes an existing account", async () => {
    const resp = await onRequestDelete(context(request("DELETE")) as never);
    expect(resp.status).toBe(200);
    expect(vi.mocked(execute)).toHaveBeenCalledWith(
      env.DB,
      "DELETE FROM apple_accounts WHERE id = ?",
      1,
    );
  });

  /**
   * W9-4 / W9-6：改密与删除是最敏感的管理操作，必须留审计；D1 故障也不能
   * 被说成「该邮箱已存在」。
   */
  describe("audit and error classification", () => {
    const updateBody = {
      email: "alice@account.limooo.cn",
      password: "",
      notes: "",
      password_changed: false,
    };

    function auditCall() {
      return vi.mocked(logEvent).mock.calls.find((call) => call[1] === "audit_event");
    }

    it("audits a successful update with the actor and never the password", async () => {
      vi.mocked(queryAll).mockResolvedValueOnce([{ password: "old-cipher" }]);
      const resp = await onRequestPut(context(request("PUT", updateBody)) as never);
      expect(resp.status).toBe(200);
      const audit = auditCall();
      expect(audit).toBeTruthy();
      const details = audit?.[3] as { outcome?: string; actorSub?: string; status?: number };
      expect(details?.outcome).toBe("account_updated");
      expect(details?.actorSub).toBe("user-1");
      expect(details?.status).toBe(200);
      expect(JSON.stringify(audit)).not.toContain("old-cipher");
    });

    it("audits a password change without recording the new password", async () => {
      vi.mocked(queryAll).mockResolvedValueOnce([]);
      const resp = await onRequestPut(
        context(
          request("PUT", {
            email: "alice@account.limooo.cn",
            password: "brand-new-secret",
            notes: "",
            password_changed: true,
          }),
        ) as never,
      );
      expect(resp.status).toBe(200);
      const details = auditCall()?.[3] as { message?: string } | undefined;
      expect(details?.message).toBe("password_changed");
      expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain("brand-new-secret");
    });

    it("returns 500 for a non-UNIQUE D1 failure on update", async () => {
      vi.mocked(queryAll).mockResolvedValueOnce([{ password: "old-cipher" }]);
      vi.mocked(execute).mockRejectedValueOnce(new Error("D1_ERROR: Exceeded maximum DB size"));
      const resp = await onRequestPut(context(request("PUT", updateBody)) as never);
      expect(resp.status).toBe(500);
      expect(((await resp.json()) as { error: string }).error).not.toContain("已存在");
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("account_update_failed");
    });

    it("still returns 409 for a real UNIQUE conflict on update", async () => {
      vi.mocked(queryAll).mockResolvedValueOnce([{ password: "old-cipher" }]);
      vi.mocked(execute).mockRejectedValueOnce(
        new Error("D1_ERROR: UNIQUE constraint failed: apple_accounts.email"),
      );
      const resp = await onRequestPut(context(request("PUT", updateBody)) as never);
      expect(resp.status).toBe(409);
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("account_update_conflict");
    });

    it("audits a successful delete and a 404", async () => {
      const ok = await onRequestDelete(context(request("DELETE")) as never);
      expect(ok.status).toBe(200);
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("account_deleted");

      vi.mocked(logEvent).mockClear();
      vi.mocked(queryAll).mockResolvedValueOnce([]);
      const missing = await onRequestDelete(context(request("DELETE")) as never);
      expect(missing.status).toBe(404);
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("account_delete_not_found");
    });
  });
});
