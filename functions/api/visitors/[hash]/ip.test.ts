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

/** /api/visitors/<hash>/ip：admin-only 单行解密。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./ip";
import { queryAll } from "../../../_lib/d1";
import { requireAuth } from "../../../_lib/session";
import { fernetEncrypt } from "../../../_lib/fernet";
import { logEvent } from "../../../_lib/logging";
import type { Env } from "../../../_lib/env";

vi.mock("../../../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../../../_lib/logging", () => ({ logEvent: vi.fn() }));
vi.mock("../../../_lib/session", async () => {
  // 共用桩（docs/22 W5-15）：语义与位置说明见 tests/helpers/admin-session.ts。
  const { createSessionModuleMock } = await import("../../../../tests/helpers/admin-session");
  return createSessionModuleMock();
});

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const HASH = "0123456789abcdef";

function context(hash: string, env: Env) {
  return {
    request: new Request(`https://visitor.limooo.cn/api/visitors/${hash}/ip`),
    env,
    params: { hash },
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({ role: "admin" } as never);
  vi.mocked(queryAll).mockResolvedValue([]);
});

describe("visitor ip API", () => {
  it("decrypts the most recent encrypted IP of that hash", async () => {
    const token = await fernetEncrypt("8.8.8.8", TEST_KEY);
    vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: token }]);

    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(data.ip).toBe("8.8.8.8");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    const sql = vi.mocked(queryAll).mock.calls[0][1] as string;
    expect(sql).toContain("FROM visitor_rollups");
    expect(sql).toContain("ORDER BY last_ts DESC");
    expect(vi.mocked(queryAll).mock.calls[0][2]).toBe(HASH);
  });

  it("returns 401 when unauthenticated and 403 for non-admins", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    let resp = await onRequestGet(context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never);
    expect(resp.status).toBe(401);

    vi.mocked(requireAuth).mockResolvedValue({ role: "viewer" } as never);
    resp = await onRequestGet(context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never);
    expect(resp.status).toBe(403);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  // W5-15：撤销表不可用时必须 fail-closed（503），不能退化成 401/404。
  it("fails closed with 503 when the session store is unavailable", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error("auth_sessions_unavailable"));
    const resp = await onRequestGet(context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never);
    expect(resp.status).toBe(503);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed hash without touching D1", async () => {
    const resp = await onRequestGet(
      context("NOT-A-HASH", { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(400);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 503 when the decryption key is missing", async () => {
    const resp = await onRequestGet(context(HASH, {} as Env) as never);
    expect(resp.status).toBe(503);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns 404 for legacy rows or rows without ciphertext", async () => {
    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe("ip_unavailable");
  });

  it("returns 500 without leaking anything when the ciphertext is corrupt", async () => {
    vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: "corrupted-token" }]);
    const resp = await onRequestGet(
      context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
    );
    expect(resp.status).toBe(500);
    expect((await resp.json()).error).toBe("ip_unavailable");
  });

  /**
   * W9-4：解密明文 IP 是最敏感的读操作。同类的密码查看（reveal.ts）一直有审计，
   * 这里此前一条都没有 —— 「谁在什么时候看了哪个访客的真实 IP」无从追溯。
   */
  describe("audit trail", () => {
    function auditCall() {
      return vi.mocked(logEvent).mock.calls.find((call) => call[1] === "audit_event");
    }

    it("writes an audit row on success without the plaintext IP", async () => {
      const token = await fernetEncrypt("8.8.8.8", TEST_KEY);
      vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: token }]);

      const resp = await onRequestGet(
        context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
      );
      expect(resp.status).toBe(200);

      const audit = auditCall();
      expect(audit, "解密成功必须写 audit_event").toBeTruthy();
      const details = audit?.[3] as { outcome?: string; status?: number; message?: string };
      expect(details?.outcome).toBe("visitor_ip_revealed");
      expect(details?.status).toBe(200);
      // 审计里只能有哈希，不能出现明文 IP。
      expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain("8.8.8.8");
      expect(details?.message).toContain(HASH);
    });

    it("writes an audit row when the decryption fails", async () => {
      vi.mocked(queryAll).mockResolvedValueOnce([{ ip_enc: "not-a-fernet-token" }]);
      const resp = await onRequestGet(
        context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
      );
      expect(resp.status).toBe(500);
      const details = auditCall()?.[3] as { outcome?: string; status?: number } | undefined;
      expect(details?.outcome).toBe("visitor_ip_decrypt_failed");
      expect(details?.status).toBe(500);
    });

    it("writes an audit row when the key is missing or the row has no ciphertext", async () => {
      const noKey = await onRequestGet(context(HASH, {} as Env) as never);
      expect(noKey.status).toBe(503);
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("visitor_ip_unavailable");

      vi.mocked(logEvent).mockClear();
      vi.mocked(queryAll).mockResolvedValueOnce([]);
      const noRow = await onRequestGet(
        context(HASH, { VISITOR_IP_KEY: TEST_KEY } as Env) as never,
      );
      expect(noRow.status).toBe(404);
      expect((auditCall()?.[3] as { outcome?: string })?.outcome).toBe("visitor_ip_missing");
    });
  });
});
