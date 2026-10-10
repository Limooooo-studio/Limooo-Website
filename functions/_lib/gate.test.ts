/** isBlocked 的 CIDR 精确匹配测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATE_RENEW_AFTER_SECONDS,
  allCookieValues,
  gateCookieHeaders,
  handleGateDiag,
  handleVerify,
  isBlocked,
  mintGateCookie,
  readGateCookie,
  verifyTurnstile,
} from "./gate";
import type { RequestContext } from "./routing";
import { queryAll } from "./d1";
import { logEvent } from "./logging";

vi.mock("./d1", () => ({ queryAll: vi.fn() }));
vi.mock("./logging", () => ({ logEvent: vi.fn() }));

const env = { DB: {} } as never;
const request = new Request("https://limooo.cn/");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isBlocked", () => {
  it("ignores spoofed X-Limooo-Client-* headers and shows the connecting IP", async () => {
    const req = new Request("https://auth.limooo.cn/__gate/diag", {
      headers: {
        "CF-Connecting-IP": "43.108.57.161",
        "X-Limooo-Client-IP": "203.0.113.9",
        "X-Limooo-Client-Country": "jp",
      },
    });
    const diag = handleGateDiag({ request: req } as RequestContext);
    expect(await diag.json()).toMatchObject({ ip: "43.108.57.161", country: "—" });
  });

  it("falls back to the connecting IP when no forwarded header is present", async () => {
    const req = new Request("https://auth.limooo.cn/__gate/diag", {
      headers: { "CF-Connecting-IP": "43.108.57.161", "X-Limooo-Client-IP": "not-an-ip" },
    });
    const diag = handleGateDiag({ request: req } as RequestContext);
    expect(await diag.json()).toMatchObject({ ip: "43.108.57.161", country: "—" });
  });

  it("matches IPv4 /24 with normalized network/prefix", async () => {
    vi.mocked(queryAll).mockResolvedValue([
      { cidr: "1.2.3.0/24", network: "1.2.3.0", prefix: 24 },
    ]);
    expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
    expect(vi.mocked(logEvent)).toHaveBeenCalled();
    const sql = vi.mocked(queryAll).mock.calls[0][1];
    expect(sql).toContain("network = ? AND prefix = ?");
  });

  it("matches IPv6 /64 and exact /32 semantics", async () => {
    vi.mocked(queryAll).mockResolvedValue([
      { cidr: "2001:db8::/64", network: "2001:db8::", prefix: 64 },
    ]);
    expect(await isBlocked(env, request, "2001:db8::1")).toBe(true);
  });

  it("returns false when no row matches and logs nothing", async () => {
    vi.mocked(queryAll).mockResolvedValue([]);
    expect(await isBlocked(env, request, "8.8.8.8")).toBe(false);
    expect(vi.mocked(logEvent)).not.toHaveBeenCalled();
  });
});

describe("handleVerify", () => {
  function verifyContext(request: Request) {
    return {
      request,
      env: {
        TURNSTILE_SECRET: "turnstile-secret",
        GATE_HMAC_KEY: "a".repeat(64),
      },
      next: async () => new Response("next"),
    } as never;
  }

  function verifyRequest(accept: string, token = "token"): Request {
    const form = new FormData();
    form.set("cf-turnstile-response", token);
    form.set("host", "limooo.cn");
    form.set("next", "/services");
    return new Request("https://limooo.cn/__gate/verify", {
      method: "POST",
      headers: { Accept: accept },
      body: form,
    });
  }

  it("issues the gate cookie to fetch clients without a redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));

    const resp = await handleVerify(verifyContext(verifyRequest("application/json")));

    expect(resp.status).toBe(204);
    expect(resp.headers.get("Location")).toBeNull();
    expect(resp.headers.get("Set-Cookie")).toContain("__gate=");
    vi.unstubAllGlobals();
  });

  it("keeps verification errors on the current page for fetch clients", async () => {
    const resp = await handleVerify(verifyContext(verifyRequest("application/json", "")));

    expect(resp.status).toBe(403);
    await expect(resp.json()).resolves.toEqual({ ok: false, error: "failed" });
  });

  it("sends non-JavaScript form posts directly back to the requested host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));

    const resp = await handleVerify(verifyContext(verifyRequest("text/html")));

    expect(resp.status).toBe(303);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
    vi.unstubAllGlobals();
  });

  it("passes CF-Connecting-IP to siteverify, ignoring spoofed forwarded headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const form = new FormData();
    form.set("cf-turnstile-response", "token");
    form.set("host", "limooo.cn");
    form.set("next", "/services");
    const request = new Request("https://limooo.cn/__gate/verify", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "CF-Connecting-IP": "43.108.57.161",
        "X-Limooo-Client-IP": "1.2.3.4",
        "X-Limooo-Client-Country": "CN",
      },
      body: form,
    });

    await handleVerify(verifyContext(request));

    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.get("remoteip")).toBe("43.108.57.161");
    expect(body.get("remoteip")).not.toBe("1.2.3.4");
    vi.unstubAllGlobals();
  });
});

describe("__gate cookie: signature, expiry and renewal", () => {
  const KEY = "k".repeat(64);

  async function mintAt(nowSeconds: number): Promise<string> {
    vi.useFakeTimers();
    vi.setSystemTime(nowSeconds * 1000);
    const header = await mintGateCookie(KEY);
    vi.useRealTimers();
    return header.split(";")[0].split("=").slice(1).join("=");
  }

  it("signs issued+expiry so a valid cookie cannot be extended by rewriting it", async () => {
    const value = await mintAt(1_700_000_000);
    const [issued, expiry, signature] = value.split(".");
    // 攻击者把过期时间往后推，签名对不上 -> 无效。
    const forged = `${issued}.${Number(expiry) + 86400}.${signature}`;
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_100 * 1000);
    await expect(readGateCookie(forged, KEY)).resolves.toMatchObject({ valid: false });
    await expect(readGateCookie(value, KEY)).resolves.toMatchObject({ valid: true });
    vi.useRealTimers();
  });

  it("rejects the legacy two-field cookie format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    await expect(readGateCookie("1700003600.deadbeef", KEY)).resolves.toMatchObject({
      valid: false,
    });
    vi.useRealTimers();
  });

  it("expires exactly one hour after it was issued", async () => {
    const value = await mintAt(1_700_000_000);
    vi.useFakeTimers();
    vi.setSystemTime((1_700_000_000 + 3600 - 5) * 1000);
    await expect(readGateCookie(value, KEY)).resolves.toMatchObject({ valid: true });
    vi.setSystemTime((1_700_000_000 + 3600 + 1) * 1000);
    await expect(readGateCookie(value, KEY)).resolves.toMatchObject({ valid: false });
    vi.useRealTimers();
  });

  it("only asks for renewal once the cookie is 3/4 through its TTL", async () => {
    const value = await mintAt(1_700_000_000);
    vi.useFakeTimers();
    // 刚签发：不续期，避免每次请求都重签（滑动窗口漂移）。
    vi.setSystemTime((1_700_000_000 + 60) * 1000);
    await expect(readGateCookie(value, KEY)).resolves.toMatchObject({
      valid: true,
      shouldRenew: false,
    });
    // 走完 3/4 TTL：开始续期。
    vi.setSystemTime((1_700_000_000 + GATE_RENEW_AFTER_SECONDS + 1) * 1000);
    await expect(readGateCookie(value, KEY)).resolves.toMatchObject({
      valid: true,
      shouldRenew: true,
    });
    vi.useRealTimers();
  });
});

describe("duplicate __gate names and issue-time cleanup", () => {
  const KEY = "k".repeat(64);

  it("collects every same-named __gate, not just the first", () => {
    const stale = `__gate=1790000000.1790003600.${"a".repeat(64)}`;
    const values = allCookieValues("__gate", `${stale}; __gate=fresh; other=1`);
    expect(values).toEqual([`1790000000.1790003600.${"a".repeat(64)}`, "fresh"]);
  });

  it("clears the legacy host-only scope before writing the domain cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const headers = await gateCookieHeaders(KEY);
    vi.useRealTimers();

    expect(headers).toHaveLength(2);
    // 第一条删除 host-only 变体：不能带 Domain，否则删不掉它。
    expect(headers[0]).toContain("__gate=;");
    expect(headers[0]).toContain("Max-Age=0");
    expect(headers[0]).not.toContain("Domain=");
    // 第二条写入正常的 1h 域级 cookie。
    expect(headers[1]).toContain("Domain=.limooo.cn");
    expect(headers[1]).toContain("Max-Age=3600");
  });

  it("validation returns a categorised failure reason for diagnostics", async () => {
    const key = "k".repeat(64);
    await expect(readGateCookie(undefined, key)).resolves.toMatchObject({
      valid: false,
      present: false,
      reason: "absent",
    });
    await expect(readGateCookie("only-two.fields", key)).resolves.toMatchObject({
      valid: false,
      reason: "malformed",
    });
    await expect(
      readGateCookie(`1700000000.1700003600.${"b".repeat(64)}`, key),
    ).resolves.toMatchObject({ valid: false, reason: "bad_signature" });
  });
});
