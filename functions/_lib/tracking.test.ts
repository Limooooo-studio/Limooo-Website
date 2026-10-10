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

/** 埋点最小字段与降噪测试：mock D1，不访问真实数据库/网络。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./d1";
import type { Env } from "./env";
import {
  pageSlug,
  recordRay,
  recordVisit,
  shouldTrackRay,
  shouldTrackVisit,
  uaFamily,
} from "./tracking";
import { decryptVisitorIp } from "./visitor-ip";

vi.mock("./d1", () => ({ execute: vi.fn(), executeBatch: vi.fn() }));
vi.mock("cloudflare:sockets", () => ({}));

// 固定测试用 Fernet 密钥（非生产密钥）：没有它 ip_enc 永远是空串，
// 「不泄露 IP」的断言会变成空转 —— 什么都没写进去，当然也断言不出泄露。
const VISITOR_IP_KEY = "bShtbuGO2EDEej4Wl7eWpmiZkYsnX8s7GkShvTMFp5s=";

const env = {
  DB: {},
  OBSERVABILITY_HMAC_KEY: "obs-key-for-tests",
  VISITOR_IP_KEY,
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execute).mockResolvedValue(true);
});

function request(url: string, headers: HeadersInit = {}) {
  return new Request(url, { headers });
}

describe("tracking", () => {
  it("normalizes paths and user agents", () => {
    expect(pageSlug("/portfolio?id=1")).toBe("portfolio");
    expect(pageSlug("/")).toBe("home");
    expect(uaFamily("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
    expect(uaFamily("Mozilla/5.0 (Macintosh; Safari)")).toBe("safari");
  });

  it("skips static, API, image and redirect requests", () => {
    const page = request("https://limooo.cn/", { "CF-Connecting-IP": "1.1.1.1" });
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/"))).toBe(true);
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/static/a.css"))).toBe(false);
    expect(shouldTrackVisit(page, new URL("https://limooo.cn/api/x"))).toBe(false);
    expect(shouldTrackVisit(page, new URL("https://images.limooo.cn/x.webp"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/static/a.css"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/api/x"))).toBe(false);
    expect(shouldTrackRay(page, new URL("https://limooo.cn/"))).toBe(true);
  });

  it("records the gate diagnostic request so displayed Ray IDs are traceable", () => {
    const page = request("https://auth.limooo.cn/gate/diag", { "CF-Connecting-IP": "1.1.1.1" });
    // 门禁页展示的 Ray ID 必须能在 Ray 日志里反查：这是唯一豁免的 /gate 接口。
    expect(shouldTrackRay(page, new URL("https://auth.limooo.cn/gate/diag"))).toBe(true);
    expect(shouldTrackRay(page, new URL("https://auth.limooo.cn/__gate/diag"))).toBe(true);
  });

  it("does not write D1 rows for the gate page's own config/diag/verify endpoints", () => {
    // 门禁页每次渲染都会 GET /gate/config 与 /gate/diag，每次提交都 POST /gate/verify。
    // 这些路径此前**不在**排除名单里（名单只写了旧前缀 /__gate），于是未验证访客
    // 每看一次门禁页就换 1–2 条 D1 写入，匿名即可放大写额度（docs/22 W9 额外发现）。
    const page = request("https://auth.limooo.cn/gate/config", { "CF-Connecting-IP": "1.1.1.1" });
    for (const path of [
      "/gate/config",
      "/gate/diag",
      "/gate/verify",
      "/__gate/config",
      "/__gate/diag",
      "/__gate/verify",
    ]) {
      const url = new URL(`https://auth.limooo.cn${path}`);
      expect(shouldTrackVisit(page, url), `visit ${path}`).toBe(false);
      // diag 是唯一允许记 Ray 的接口。
      const expectedRay = path.endsWith("/diag");
      expect(shouldTrackRay(page, url), `ray ${path}`).toBe(expectedRay);
    }
    // 门禁页本身（/gate）仍按普通页面记录。
    expect(shouldTrackRay(page, new URL("https://auth.limooo.cn/gate"))).toBe(true);
    expect(shouldTrackVisit(page, new URL("https://auth.limooo.cn/gate"))).toBe(true);
  });

  it("records visitors without full IP/UA/query", async () => {
    await recordVisit(
      env,
      request("https://limooo.cn/portfolio?secret=1", {
        "CF-Connecting-IP": "8.8.8.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      }),
      200,
    );
    const calls = vi.mocked(execute).mock.calls;
    const insert = calls.find((call) => String(call[1]).includes("INSERT INTO visitor_rollups"));
    expect(insert).toBeDefined();
    expect(String(insert![1])).toContain("ON CONFLICT");
    const values = insert!.slice(2).map(String);
    expect(values).toContain("portfolio");
    expect(values.some((value) => value.includes("8.8.8.8") || value.includes("secret=1"))).toBe(false);
    expect(values.some((value) => value.includes("Macintosh"))).toBe(false);
  });

  it("stores an encrypted visitor IP that decryptVisitorIp can recover", async () => {
    await recordVisit(
      env,
      request("https://limooo.cn/portfolio", { "CF-Connecting-IP": "8.8.8.8" }),
      200,
    );
    const calls = vi.mocked(execute).mock.calls;
    const insert = calls.find((call) => String(call[1]).includes("INSERT INTO visitor_rollups"));
    expect(insert).toBeDefined();
    const values = insert!.slice(2).map(String);

    // ip_enc 必须是**真加密**：写进去的密文能解回原 IP。
    const decrypted = await Promise.all(values.map((value) => decryptVisitorIp(value, env)));
    expect(decrypted).toContain("8.8.8.8");
    // 同一批参数里不允许出现明文 IP（列表接口与日志都从这里取值）。
    expect(values.some((value) => value.includes("8.8.8.8"))).toBe(false);
    await expect(decryptVisitorIp("", env)).resolves.toBeNull();
  });

  it("records ray requests without full IP/UA/query", async () => {
    await recordRay(
      env,
      request("https://limooo.cn/login/callback?code=topsecret", {
        "CF-Ray": "abc123",
        "CF-Connecting-IP": "8.8.8.8",
        "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.0)",
      }),
      200,
      12,
    );
    const calls = vi.mocked(execute).mock.calls;
    const insert = calls.find((call) => String(call[1]).includes("INSERT OR IGNORE INTO ray_log_v2"));
    expect(insert).toBeDefined();
    const values = insert!.slice(2).map(String);
    expect(values).toContain("/login/callback");
    expect(values.some((value) => value.includes("8.8.8.8") || value.includes("topsecret"))).toBe(false);
    expect(values.some((value) => value.includes("GPTBot"))).toBe(false);
  });

  /**
   * W9-19：D1 故障期间不能让每个请求都先打一批必然失败的建表语句。
   * 这里只验证「冷却窗口内只尝试一次 + 走一次 batch 往返」。
   */
  it("attempts the visitor schema once per cooldown and in a single batch", async () => {
    vi.resetModules();
    const mod = await import("./tracking");
    const { executeBatch: batchMock } = await import("./d1");
    vi.mocked(batchMock).mockResolvedValue(false); // D1 一直失败
    vi.mocked(execute).mockResolvedValue(false);

    const failing = {
      batch: () => undefined,
      prepare: () => ({ bind: () => ({ run: async () => ({ success: false }) }) }),
    } as unknown as Env;
    const localEnv = { ...env, DB: failing } as Env;

    for (let i = 0; i < 4; i++) {
      await mod.recordVisit(localEnv, request("https://limooo.cn/"), 200);
    }
    expect(vi.mocked(batchMock)).toHaveBeenCalledTimes(1);
    // 冷却窗口内不再逐句跑 DDL（INSERT 落库仍会调用 execute，这里只看 DDL）。
    const ddl = vi
      .mocked(execute)
      .mock.calls.filter((call) => String(call[1]).startsWith("CREATE TABLE"));
    expect(ddl).toHaveLength(0);
  });
});
