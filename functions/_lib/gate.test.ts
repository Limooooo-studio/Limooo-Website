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

/** isBlocked 的 CIDR 精确匹配测试（docs/10）。 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED_LIST_TTL_MS,
  GATE_RENEW_AFTER_SECONDS,
  allCookieValues,
  gateCookieHeaders,
  handleGateDiag,
  handleVerify,
  isBlocked,
  mintGateCookie,
  readGateCookie,
  renderGatePage,
  verifyTurnstile,
} from "./gate";
import type { RequestContext } from "./routing";
import { queryAll } from "./d1";
import { logEvent } from "./logging";
import { BASE_URL, LANG_COOKIE } from "./config";

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "limooo.cn" })));

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "limooo.cn" })));

    const resp = await handleVerify(verifyContext(verifyRequest("text/html")));

    expect(resp.status).toBe(303);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
    vi.unstubAllGlobals();
  });

  it("fails closed when GATE_HMAC_KEY is missing instead of signing with an empty key", async () => {
    // handleVerify 此前只检查 TURNSTILE_SECRET；GATE_HMAC_KEY 为空时它会继续签发
    // 一枚用空密钥签的 __gate cookie（今天靠中间件的 runtimeConfigError 兜住，
    // 但「中间件路由缺失时的兜底入口」自己必须有这道门）。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "limooo.cn" })));
    const resp = await handleVerify({
      request: verifyRequest("application/json"),
      env: { TURNSTILE_SECRET: "turnstile-secret" },
      next: async () => new Response("next"),
    } as never);

    expect(resp.status).toBe(503);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("passes CF-Connecting-IP to siteverify, ignoring spoofed forwarded headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, hostname: "limooo.cn" }));
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

  /**
   * W9-16：siteverify 返回的 hostname / action 一并校验（纵深防御）。
   *
   * 同一个 sitekey 若被加到别的域名或别的组件（widget）上，其它站点解出的 token
   * 也能通过我们的 siteverify —— 只校验 success 就等于把「本站访客」的定义
   * 交给 Cloudflare 与 sitekey 配置。这里按 managed hosts 收紧。
   */
  it("rejects a token solved on a host we do not manage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ success: true, hostname: "evil.example", action: "gate" }),
      ),
    );
    const resp = await handleVerify(verifyContext(verifyRequest("application/json")));
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
    expect(await resp.json()).toMatchObject({ ok: false, error: "failed" });
    vi.unstubAllGlobals();
  });

  it("accepts every host the contract manages", async () => {
    for (const hostname of ["limooo.cn", "services.limooo.cn", "visitor.limooo.cn"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ success: true, hostname, action: "gate" })),
      );
      const resp = await handleVerify(verifyContext(verifyRequest("application/json")));
      expect(resp.status, hostname).toBe(204);
      vi.unstubAllGlobals();
    }
  });

  it("rejects a token solved for a different widget action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ success: true, hostname: "limooo.cn", action: "newsletter" }),
      ),
    );
    const resp = await handleVerify(verifyContext(verifyRequest("application/json")));
    expect(resp.status).toBe(403);
    vi.unstubAllGlobals();
  });

  it("rejects a siteverify response with no hostname at all", async () => {
    // 缺 hostname 时不能按「没给就别管」放行，否则这份纵深防御等于可被省略。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true })));
    const resp = await handleVerify(verifyContext(verifyRequest("application/json")));
    expect(resp.status).toBe(403);
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

/**
 * blocked_ips 进程内缓存（docs/22 增量 ①）。
 *
 * 这些用例把「缓存命中不再查库」「TTL 过期重查」「读失败回退且不放大故障」
 * 「不同 env.DB 不串味」以及「缓存路径与逐前缀查询路径判定逐项一致」钉死。
 * 上面的既有用例走的是 `env.DB = {}`（没有 prepare）→ 全量读必然失败 →
 * 回退路径，因此改动前后行为不变。
 */
describe("isBlocked blocked_ips cache", () => {
  type Row = { cidr: string; network: string; prefix: number; active?: number };

  /** 复刻 D1 上 blocked_ips 两条查询形态的桩（含 active 过滤与排序/限行语义）。 */
  function fakeDb(rows: Row[], options: { listReadFails?: boolean } = {}) {
    const counters = { prepare: 0, blocked: 0, listReads: 0 };
    const visible = () => rows.filter((row) => (row.active ?? 1) === 1);
    const db = {
      counters,
      prepare(sql: string) {
        counters.prepare += 1;
        const isList = !sql.includes("(network = ? AND prefix = ?)");
        if (sql.includes("blocked_ips")) counters.blocked += 1;
        const all = async (values: unknown[]) => {
          if (isList) {
            counters.listReads += 1;
            if (options.listReadFails) return { success: false, results: [] };
            return { success: true, results: visible() };
          }
          const out: Row[] = [];
          for (let i = 0; i < values.length; i += 2) {
            const network = String(values[i]);
            const prefix = Number(values[i + 1]);
            for (const row of visible()) {
              if (row.network === network && Number(row.prefix) === prefix) out.push(row);
            }
          }
          return { success: true, results: out.sort((a, b) => b.prefix - a.prefix).slice(0, 1) };
        };
        const stmt = {
          bind: (...values: unknown[]) => ({
            all: () => all(values),
            run: async () => ({ success: true, meta: { changes: 1 } }),
            first: async () => null,
          }),
          all: () => all([]),
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null,
        };
        return stmt;
      },
    };
    return db;
  }

  /** 让被 mock 掉的 queryAll 走真实桩，从而同时覆盖回退路径（绑定参数必须照传）。 */
  function wireQueryAll(db: ReturnType<typeof fakeDb>) {
    vi.mocked(queryAll).mockImplementation(
      async (_db: unknown, sql: string, ...values: unknown[]) => {
        const stmt = db.prepare(sql) as {
          bind(...args: unknown[]): { all(): Promise<{ results: Row[] }> };
        };
        return (await stmt.bind(...values).all()).results;
      },
    );
  }

  const blocking = [{ cidr: "1.2.3.0/24", network: "1.2.3.0", prefix: 24 }];

  it("reads blocked_ips once and answers the next request from memory", async () => {
    const db = fakeDb(blocking);
    wireQueryAll(db);
    const env = { DB: db } as never;

    expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
    expect(await isBlocked(env, request, "1.2.3.10")).toBe(true);

    expect(db.counters.listReads).toBe(1);
    // 全过程只有那一次全量读，逐前缀查询一次都没跑。
    expect(db.counters.blocked).toBe(1);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("re-reads after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const db = fakeDb(blocking);
      wireQueryAll(db);
      const env = { DB: db } as never;

      expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
      expect(db.counters.listReads).toBe(1);

      // TTL 内：仍然是同一次读取。
      vi.setSystemTime(1_700_000_000_000 + BLOCKED_LIST_TTL_MS - 1);
      expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
      expect(db.counters.listReads).toBe(1);

      // 越过 TTL：必须重查。
      vi.setSystemTime(1_700_000_000_000 + BLOCKED_LIST_TTL_MS);
      expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
      expect(db.counters.listReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the per-prefix query when the list read fails, and still blocks", async () => {
    const db = fakeDb(blocking, { listReadFails: true });
    wireQueryAll(db);
    const env = { DB: db } as never;

    expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
    expect(vi.mocked(queryAll)).toHaveBeenCalled();
    expect(vi.mocked(logEvent)).toHaveBeenCalled();

    // 失败也要记住：冷却窗口内不再重试全量读，否则 D1 抖动期间每个请求都会多打一次。
    expect(await isBlocked(env, request, "1.2.3.9")).toBe(true);
    expect(db.counters.listReads).toBe(1);
  });

  it("does not treat a failed list read as an empty blocklist", async () => {
    // 驱动回 success=false 时绝不能把空列表当结论：必须回退并照常封禁。
    const db = fakeDb(blocking, { listReadFails: true });
    wireQueryAll(db);
    expect(await isBlocked({ DB: db } as never, request, "1.2.3.9")).toBe(true);
  });

  it("keeps one cache per DB binding so two environments cannot leak into each other", async () => {
    const blockingDb = fakeDb(blocking);
    const cleanDb = fakeDb([]);
    wireQueryAll(blockingDb);

    expect(await isBlocked({ DB: blockingDb } as never, request, "1.2.3.9")).toBe(true);
    // 同一个 IP、另一个 DB 绑定：必须是它自己的（空）名单，不能命中前一个环境的缓存。
    expect(await isBlocked({ DB: cleanDb } as never, request, "1.2.3.9")).toBe(false);
    expect(cleanDb.counters.listReads).toBe(1);
  });

  it("agrees with the per-prefix query path on IPv4/IPv6/boundary and active=0 rows", async () => {
    const table: Row[] = [
      { cidr: "203.0.113.0/24", network: "203.0.113.0", prefix: 24 },
      { cidr: "203.0.113.9/32", network: "203.0.113.9", prefix: 32 },
      { cidr: "198.51.100.0/25", network: "198.51.100.0", prefix: 25 },
      { cidr: "10.0.0.0/8", network: "10.0.0.0", prefix: 8 },
      { cidr: "2001:db8::/32", network: "2001:db8::", prefix: 32 },
      { cidr: "2001:db8:dead:beef::/64", network: "2001:db8:dead:beef::", prefix: 64 },
      { cidr: "2001:db8:dead:beef::1/128", network: "2001:db8:dead:beef::1", prefix: 128 },
      // active=0 的行两侧都必须忽略（软删除的解封语义）。
      { cidr: "172.16.0.0/12", network: "172.16.0.0", prefix: 12, active: 0 },
      { cidr: "192.0.2.77/32", network: "192.0.2.77", prefix: 32, active: 0 },
      { cidr: "2001:db9:2::/48", network: "2001:db9:2::", prefix: 48, active: 0 },
    ];
    const ips = [
      "203.0.113.9",
      "203.0.113.10",
      "198.51.100.0",
      "198.51.100.127",
      "198.51.100.128",
      "10.1.2.3",
      "11.0.0.1",
      "172.16.5.5",
      "192.0.2.77",
      "2001:db8::1",
      "2001:db8:dead:beef::1",
      "2001:db8:dead:beef::2",
      "2001:db8:2::1",
      "2001:db9:2::1",
      "2001:db9::1",
      "::1",
      "::ffff:203.0.113.9",
      "not-an-ip",
      "",
    ];

    const verdictsFor = async (listReadFails: boolean) => {
      const db = fakeDb(table, { listReadFails });
      wireQueryAll(db);
      const env = { DB: db } as never;
      const out: Array<[string, boolean, string]> = [];
      for (const ip of ips) {
        vi.mocked(logEvent).mockClear();
        const blocked = await isBlocked(env, request, ip);
        const message = vi.mocked(logEvent).mock.calls[0]?.[3]?.message ?? "";
        out.push([ip, blocked, message]);
      }
      return out;
    };

    // 缓存路径（全量读成功）vs 查询路径（全量读失败 → 回退到改动前的实现）。
    const cached = await verdictsFor(false);
    const queried = await verdictsFor(true);

    expect(cached).toEqual(queried);
    // 用例本身必须有区分度：既要有命中的，也要有放行的。
    expect(cached.filter(([, blocked]) => blocked).length).toBeGreaterThan(5);
    expect(cached.filter(([, blocked]) => !blocked).length).toBeGreaterThan(3);
    // /32 必须压过同段的 /24（cidr 取值与查询路径一致）。
    expect(cached.find(([ip]) => ip === "203.0.113.9")?.[2]).toBe("cidr=203.0.113.9/32");
    // active=0 的行无论如何都不能命中。
    expect(cached.find(([ip]) => ip === "172.16.5.5")?.[1]).toBe(false);
    expect(cached.find(([ip]) => ip === "192.0.2.77")?.[1]).toBe(false);
    expect(cached.find(([ip]) => ip === "2001:db9:2::1")?.[1]).toBe(false);
    // 对照：active=1 的 /32 网段里同类地址照样命中（说明上面不是「整个网段都没查」）。
    expect(cached.find(([ip]) => ip === "2001:db8:2::1")?.[1]).toBe(true);
  });

  it("treats a /0 row as a match for its own address family only", async () => {
    // 边界前缀 0：缓存路径用 contains 判、查询路径用 networkAddress 判，
    // 两条路都必须「只匹配同一地址族」。既有用例只覆盖到 /8、/24、/128。
    const rows: Row[] = [
      { cidr: "0.0.0.0/0", network: "0.0.0.0", prefix: 0 },
      { cidr: "::/0", network: "::", prefix: 0 },
    ];
    const matrix: Array<[string, boolean]> = [
      ["8.8.8.8", true],
      ["::1", true],
      ["2001:db8::1", true],
      ["::ffff:8.8.8.8", true],
      ["not-an-ip", false],
      ["", false],
    ];

    const verdictsFor = async (listReadFails: boolean) => {
      const db = fakeDb(rows, { listReadFails });
      wireQueryAll(db);
      const env = { DB: db } as never;
      const out: Array<[string, boolean]> = [];
      for (const ip of matrix.map(([value]) => value)) {
        out.push([ip, await isBlocked(env, request, ip)]);
      }
      return out;
    };

    const cached = await verdictsFor(false);
    expect(cached).toEqual(matrix);
    expect(await verdictsFor(true)).toEqual(cached);
  });
});

/** 门禁页模板文本缓存（docs/22 增量 ③）。 */
describe("renderGatePage template cache", () => {
  const TEMPLATE = "<html><body>{{host}}|{{next}}|{{error}}</body></html>";

  function assetsEnv() {
    const calls: string[] = [];
    return {
      calls,
      env: {
        ASSETS: {
          fetch: async (input: RequestInfo | URL) => {
            calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            return new Response(TEMPLATE, { headers: { "Content-Type": "text/html" } });
          },
        },
      } as never,
    };
  }

  function render(env: never, url = "https://limooo.cn/services", cookie?: string) {
    return renderGatePage(
      {
        request: new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined),
        env,
        next: async () => new Response("next"),
      } as never,
      { host: "limooo.cn", next: "/services" },
    );
  }

  it("fetches the template once for repeated renders of the same language", async () => {
    const { env, calls } = assetsEnv();
    const first = await render(env);
    const second = await render(env);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BASE_URL}/en-us/auth.html`);
    const [a, b] = [await first.text(), await second.text()];
    expect(a).toBe(b);
    expect(a).toContain("limooo.cn|/services|");
  });

  it("keeps one entry per language", async () => {
    const { env, calls } = assetsEnv();
    await render(env, "https://limooo.cn/services", `${LANG_COOKIE}=zh-cn`);
    await render(env, "https://limooo.cn/services", `${LANG_COOKIE}=ja-jp`);

    expect(calls).toEqual([`${BASE_URL}/zh-cn/auth.html`, `${BASE_URL}/ja-jp/auth.html`]);
  });

  it("does not cache a failed template fetch", async () => {
    let calls = 0;
    const env = {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    } as never;

    expect((await render(env)).status).toBe(503);
    expect((await render(env)).status).toBe(503);
    expect(calls).toBe(2);
  });
});
