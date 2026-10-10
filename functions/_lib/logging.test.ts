/** 日志隐私纯函数测试：独立观测密钥 + 敏感文本脱敏，不访问 D1/网络。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { ipHash, logEvent, sanitizeLogMessage } from "./logging";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging privacy", () => {
  it("uses only OBSERVABILITY_HMAC_KEY and fails closed when it is missing", async () => {
    const obs = await ipHash("8.8.8.8", { OBSERVABILITY_HMAC_KEY: "obs" } as Env);
    const gate = await ipHash("8.8.8.8", {
      GATE_HMAC_KEY: "gate",
      OBSERVABILITY_HMAC_KEY: "obs",
    } as Env);
    expect(obs).toBe(gate);
    expect(obs).toMatch(/^[0-9a-f]{16}$/);
    expect(await ipHash("8.8.8.8", { GATE_HMAC_KEY: "gate" } as Env)).toBe("");
  });

  it("hashes the connecting IP, never a client-supplied X-Limooo-Client-IP", async () => {
    const env = { OBSERVABILITY_HMAC_KEY: "obs" } as unknown as Env;
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = new Request("https://limooo.cn/", {
      headers: {
        "CF-Connecting-IP": "43.108.57.161",
        "X-Limooo-Client-IP": "1.2.3.4",
        "X-Limooo-Client-Country": "CN",
      },
    });

    await logEvent(env, "gate_entry", request, {});

    const payload = JSON.parse(String(spy.mock.calls[0][0])) as { ip_hash: string };
    expect(payload.ip_hash).toBe(await ipHash("43.108.57.161", env));
    expect(payload.ip_hash).not.toBe(await ipHash("1.2.3.4", env));
  });

  it("redacts passwords, bearer tokens, cookies and query strings", () => {
    const clean = sanitizeLogMessage(
      'login password=seekrit&token=abc123 | Bearer abc.def | Cookie: __gate=xyz | /api/a?q=secret',
    );
    expect(clean).not.toContain("seekrit");
    expect(clean).not.toContain("abc.def");
    expect(clean).not.toContain("__gate=xyz");
    expect(clean).not.toContain("q=secret");
    expect(clean).toContain("[redacted]");
  });
});
