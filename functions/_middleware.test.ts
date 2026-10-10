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

/**
 * 强制主题挑战门禁编排测试：必须无视白名单 IP / cf_clearance，并保持原 URL。
 *
 * 另有 `onRequest wrapper` 一节锁住真正被 Pages 调用的入口（安全响应头分发、
 * 多条 Set-Cookie 的保全、403 不埋点）——`handleOnRequest` 之外的最后一层。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOnRequest, onRequest, pageCacheKey } from "./_middleware";
import { GATE_TURNSTILE_ACTION, mintGateCookie } from "./_lib/gate";
import { SECURITY_HEADERS } from "./_lib/security";
import { recordRay, recordVisit, shouldTrackRay, shouldTrackVisit } from "./_lib/tracking";
import type { Env } from "./_lib/env";
import type { RequestContext } from "./_lib/routing";

// 埋点全部换成 spy：既有用例依赖「默认不埋点」，onRequest 的用例再用
// mockReturnValue 打开开关，直接断言 recordVisit / recordRay 有没有被调用。
vi.mock("./_lib/tracking", () => ({
  isTrustedCrawler: vi.fn(() => false),
  recordRay: vi.fn(async () => undefined),
  recordVisit: vi.fn(async () => undefined),
  shouldTrackRay: vi.fn(() => false),
  shouldTrackVisit: vi.fn(() => false),
}));

const keys = {
  TURNSTILE_SECRET: "turnstile-secret",
  GATE_HMAC_KEY: "a".repeat(64),
  SESSION_HMAC_KEY: "b".repeat(64),
};

function context(request: Request, env: Partial<Env> = {}): RequestContext {
  return {
    request,
    env: { ...keys, ...env } as Env,
    next: async () => new Response("next", { status: 200 }),
    waitUntil: async () => undefined,
  };
}

describe("force theme challenge", () => {
  it("renders the gate at an unverified visitor's original URL", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/"),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("limooo.cn /");
  });

  it("renders the gate at the original URL for forced challenges", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/services?challenge=1", {
          headers: {
            "CF-Connecting-IP": "97.64.18.11",
            Cookie: "cf_clearance=test",
          },
        }),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("limooo.cn /services");
  });

  it("308s the legacy /__gate entry and keeps the forced challenge on /gate", async () => {
    const assets = {
      ASSETS: {
        fetch: async () =>
          new Response(
            "<html><body>{{host}} {{next}} {{lang}} {{error}}</body></html>",
            { headers: { "Content-Type": "text/html" } },
          ),
      },
    };

    const legacy = await handleOnRequest(
      context(
        new Request(
          "https://limooo.cn/__gate?challenge=1&host=limooo.cn&next=%2Fservices",
          { headers: { Cookie: "cf_clearance=test" } },
        ),
        assets,
      ),
    );

    expect(legacy.status).toBe(308);
    expect(legacy.headers.get("Location")).toBe(
      "https://limooo.cn/gate?challenge=1&host=limooo.cn&next=%2Fservices",
    );

    // 规范化入口下强制挑战仍不放行；cf_clearance 依旧不是依据。
    const forced = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?challenge=1&host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: "cf_clearance=test" },
        }),
        assets,
      ),
    );

    expect(forced.status).toBe(403);
    expect(forced.headers.get("Location")).toBeNull();
  });

  it("ignores client-supplied X-Limooo-Client-IP when deciding trust", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            "CF-Connecting-IP": "203.0.113.9",
            "X-Limooo-Client-IP": "97.64.18.11",
            "X-Limooo-Client-Country": "CN",
          },
        }),
        {
          ASSETS: {
            fetch: async () => new Response("{{host}} {{next}}", {
              headers: { "Content-Type": "text/html" },
            }),
          },
        },
      ),
    );

    expect(resp.status).toBe(403);
  });

  it("serves redirect static assets directly instead of rendering the redirect page", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://redirect.limooo.cn/static/css/redirect.css"),
      ),
    );
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("next");
  });

  it("serves the health probe without human verification", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/_health", {
          headers: { "CF-Connecting-IP": "1.2.3.4" },
        }),
      ),
    );

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok\n");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("renders the gate page in place on the gate host for verified visitors", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://auth.limooo.cn/", {
          headers: { "CF-Connecting-IP": "97.64.18.11" },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("{{host}} {{next}}", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Location")).toBeNull();
    await expect(resp.text()).resolves.toContain("auth.limooo.cn /");
  });

  it("serves public pages with edge-cache headers", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            "CF-Connecting-IP": "97.64.18.11",
            Cookie: "user_lang_preference=zh-cn",
          },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("<html>home</html>", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    // 实测（2026-10-11）：Pages Functions 响应不进边缘缓存，所以不再声明
    // s-maxage；max-age 只服务浏览器私有缓存，stale-while-revalidate 保留。
    expect(resp.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(resp.headers.get("Cache-Control")).not.toContain("s-maxage");
    expect(resp.headers.get("Vary")).toContain("Accept-Language");
    // Vary 里不能再有 Cookie：它对边缘无效，只会给每个访客开一个缓存桶。
    expect(resp.headers.get("Vary")).not.toContain("Cookie");
  });

  it("keys the in-process page cache by host so two hosts cannot share a page", async () => {
    // www 与主域的路由表逐条相同；缓存键不含 host 时两者会互相串页。
    // 这里直接锁 pageCacheKey 的语义（渲染路径上的调用点用同一个函数）。
    const main = pageCacheKey("limooo.cn", "/en-us/index.html", "en-us").href;
    const www = pageCacheKey("www.limooo.cn", "/en-us/index.html", "en-us").href;
    expect(main).not.toBe(www);
    expect(new URL(main).hostname).toBe("limooo.cn");
    expect(new URL(www).hostname).toBe("www.limooo.cn");
    // 语言与资产路径仍在键里（否则切语言会命中旧语言页面）。
    expect(pageCacheKey("limooo.cn", "/en-us/index.html", "en-us").href).not.toBe(
      pageCacheKey("limooo.cn", "/zh-cn/index.html", "zh-cn").href,
    );
  });

  it("records the request host in the cache key it actually uses", async () => {
    const written: string[] = [];
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async () => undefined,
        put: async (req: RequestInfo | URL) => {
          written.push(typeof req === "string" ? req : req instanceof URL ? req.href : req.url);
        },
      },
    };
    try {
      const resp = await handleOnRequest(
        context(
          new Request("https://limooo.cn/", {
            headers: {
              "CF-Connecting-IP": "97.64.18.11",
              Cookie: "user_lang_preference=zh-cn",
            },
          }),
          {
            ASSETS: {
              fetch: async () =>
                new Response("<html>home</html>", {
                  headers: { "Content-Type": "text/html; charset=utf-8" },
                }),
            },
          },
        ),
      );
      expect(resp.status).toBe(200);
    } finally {
      (globalThis as { caches?: unknown }).caches = original;
    }

    expect(written).toHaveLength(1);
    expect(new URL(written[0]).hostname).toBe("limooo.cn");
    expect(new URL(written[0]).searchParams.get("lang")).toBe("zh-cn");
  });
});

describe("public /files", () => {
  const assetsEnv = (env: Partial<Env> = {}) => ({
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/static/files/after_sign_in.png")) {
          return new Response("png-bytes", {
            headers: { "Content-Type": "image/png", ETag: '"abc"' },
          });
        }
        return new Response("missing", { status: 404 });
      },
    },
    ...env,
  });

  it("serves /files/<name> without the gate, even for an unverified visitor", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/files/after_sign_in.png"), assetsEnv()),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
    expect(resp.headers.get("Cache-Control")).toContain("max-age=86400");
    await expect(resp.text()).resolves.toBe("png-bytes");
  });

  it("also maps the clean URL on the images subdomain", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://images.limooo.cn/files/after_sign_in.png"),
        assetsEnv(),
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
  });

  it("404s unknown names and path traversal without touching the gate", async () => {
    const unknown = await handleOnRequest(
      context(new Request("https://limooo.cn/files/nope.png"), assetsEnv()),
    );
    expect(unknown.status).toBe(404);

    const traversal = await handleOnRequest(
      context(new Request("https://limooo.cn/files/..%2Fsecrets"), assetsEnv()),
    );
    expect(traversal.status).toBe(404);
  });
});

describe("blocked IP enforcement", () => {
  /**
   * D1 stub：任何「查 blocked_ips 网络/前缀」的查询都命中一条 IPv4 /32 封禁。
   * 这正是 isBlocked() 在生产里唯一依赖的读取。
   */
  const blockedEnv = (env: Partial<Env> = {}) => ({
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({
            results: [{ cidr: "203.0.113.9/32", network: "203.0.113.9", prefix: 32 }],
          }),
          run: async () => ({}),
        }),
        first: async () => null,
        all: async () => ({
          results: [{ cidr: "203.0.113.9/32", network: "203.0.113.9", prefix: 32 }],
        }),
        run: async () => ({}),
      }),
    },
    ASSETS: {
      fetch: async () => new Response("assets", { status: 200 }),
    },
    ...env,
  });

  const blockedRequest = (path: string) =>
    new Request(`https://limooo.cn${path}`, {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });

  it("blocks a banned IP on /api/* instead of letting the API early-return skip the check", async () => {
    // 回归：/api/* 以前在 isBlocked 之前 return next()，封禁对整条 API 面失效。
    // （/api/ray、/api/auth、/api/apple-account 属于 exempt，见下一条用例。）
    for (const path of ["/api/visitors", "/api/blocklist", "/api/status", "/api/i18n/zh-cn"]) {
      const resp = await handleOnRequest(context(blockedRequest(path), blockedEnv()));
      expect(resp.status, `${path} must be blocked`).toBe(403);
    }
  });

  it("keeps the blocked page uncacheable and shows the blocked copy", async () => {
    const env = blockedEnv({
      ASSETS: {
        fetch: async () =>
          new Response("<html><body>{{host}} {{next}} {{error}}</body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    });
    const resp = await handleOnRequest(context(blockedRequest("/api/visitors"), env));
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    await expect(resp.text()).resolves.toContain("blocked");
  });

  it("skips the block query entirely for an already-trusted source", async () => {
    // W2-2：白名单 IP / 已验证爬虫不必查库。一次封禁检查最坏是 33 个 IPv4 前缀
    // 探测（IPv6 129 个）——所有已信任来源都照查是本审计里单项最大的固定读取开销。
    let blockQueries = 0;
    const env = blockedEnv({
      ASSETS: { fetch: async () => new Response("assets") },
    });
    const db = env.DB as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = db.prepare;
    db.prepare = (...args: unknown[]) => {
      if (String(args[0] ?? "").includes("blocked_ips")) blockQueries += 1;
      return original(...args);
    };

    // 97.64.18.11 在契约的 gate_trust 白名单里；封禁表里它是「被杀」的那一条，
    // 但信任判定优先，所以既不该查库、也不该拦。
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/services", {
          headers: { "CF-Connecting-IP": "97.64.18.11" },
        }),
        env,
      ),
    );
    expect(blockQueries).toBe(0);
    expect(resp.status).toBe(200);

    // 同一个被封 IP、同一个环境：只是不再受信任 -> 必须查库并拦截。
    const blocked = await handleOnRequest(context(blockedRequest("/services"), env));
    expect(blockQueries).toBeGreaterThan(0);
    expect(blocked.status).toBe(403);
  });

  it("still lets a banned IP reach the exempt API escape hatches", async () => {
    // exempt 名单必须继续放行：管理员从被封 IP 也要能走登录/管理接口，
    // 否则只能等 Cloudflare IP List 的下一次同步。回归点是「exempt 命中时
    // 不再调用 isBlocked」，而不是某个具体状态码。
    let blockQueries = 0;
    const env = blockedEnv({
      ASSETS: { fetch: async () => new Response("assets") },
    });
    const db = env.DB as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = db.prepare;
    db.prepare = (...args: unknown[]) => {
      const sql = String(args[0] ?? "");
      if (sql.includes("blocked_ips")) blockQueries += 1;
      return original(...args);
    };

    // 注意 routing.ts 的 isExemptPath 是「精确路径或它的子路径」：`/api/auth`
    // 命中、`/api/auth/status` 不命中（防 `/api/authx` 这类同前缀冒充）。
    // 这里只用真正被豁免的形态，子路径语义由 routing.test.ts 钉住。
    for (const path of ["/api/auth", "/api/apple-account/accounts", "/api/ray/abc123"]) {
      const resp = await handleOnRequest(context(blockedRequest(path), env));
      expect(resp.status, `${path} must stay reachable`).toBe(200);
    }
    expect(blockQueries).toBe(0);

    // 对照：非 exempt 路径确实查了封禁表，说明上面的 0 不是因为检查根本没跑。
    const blocked = await handleOnRequest(context(blockedRequest("/api/visitors"), env));
    expect(blocked.status).toBe(403);
    expect(blockQueries).toBeGreaterThan(0);
  });

  it("does not run the block query for static assets or clean /files URLs", async () => {
    let queries = 0;
    const env = blockedEnv({
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith("/static/js/actions.js")) {
            return new Response("js", { headers: { "Content-Type": "text/javascript" } });
          }
          return new Response("missing", { status: 404 });
        },
      },
    });
    const db = env.DB as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = db.prepare;
    db.prepare = (...args: unknown[]) => {
      queries += 1;
      return original(...args);
    };

    const staticResp = await handleOnRequest(
      context(new Request("https://limooo.cn/static/js/actions.js"), env),
    );
    const filesResp = await handleOnRequest(
      context(new Request("https://limooo.cn/files/after_sign_in.png"), env),
    );

    expect(staticResp.status).toBe(200);
    expect(filesResp.status).toBe(404);
    expect(queries).toBe(0);
  });

  it("does not exempt lookalike prefixes: /account-x still hits the block table", async () => {
    // 宽前缀 startsWith("/account") 会把 /account-anything 一起放行；豁免必须是
    // 精确路径或它的子路径。判据用「有没有查 blocked_ips」而不是状态码：
    // 非 API 的豁免路径拿不到封禁页，但仍可能落到门禁页（同样是 403）。
    let blockQueries = 0;
    const env = blockedEnv();
    const db = env.DB as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = db.prepare;
    db.prepare = (...args: unknown[]) => {
      if (String(args[0] ?? "").includes("blocked_ips")) blockQueries += 1;
      return original(...args);
    };

    for (const path of ["/account-takeover", "/api/raytrace", "/visitors"]) {
      blockQueries = 0;
      const resp = await handleOnRequest(context(blockedRequest(path), env));
      expect(resp.status, `${path} must be blocked`).toBe(403);
      expect(blockQueries, `${path} must consult blocked_ips`).toBeGreaterThan(0);
    }

    // 精确路径与真实子路径仍然豁免：不再查封禁表（否则管理员从被封 IP
    // 就再也登不进来）。这里只看查询次数，状态码可能是门禁页的 403。
    for (const path of ["/account", "/account/apple", "/login", "/login/callback", "/logout", "/visitor"]) {
      blockQueries = 0;
      await handleOnRequest(context(blockedRequest(path), env));
      expect(blockQueries, `${path} must stay exempt`).toBe(0);
    }
  });

  it("lets a whitelisted IP through to /api/* untouched", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/api/visitors", {
          headers: { "CF-Connecting-IP": "97.64.18.11" },
        }),
        blockedEnv(),
      ),
    );
    expect(resp.status).toBe(200);
  });
});

describe("canonical /gate entry", () => {
  const assetsEnv = {
    ASSETS: {
      fetch: async () =>
        new Response("<html><body>{{host}} {{next}} {{error}}</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
  };

  it("serves the gate page for an unverified visitor", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices"), assetsEnv),
    );
    expect(resp.status).toBe(403);
    await expect(resp.text()).resolves.toContain("limooo.cn /services");
  });

  it("sends a visitor holding a valid cookie straight back without re-challenging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
    vi.useRealTimers();
  });

  it("does not re-issue the cookie on every request while it is still fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    vi.setSystemTime((1_700_000_000 + 60) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2F", {
          headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(302);
    // 语言 cookie 可能顺带写入，但 __gate 不应被重复签发。
    expect(resp.headers.get("Set-Cookie") ?? "").not.toContain("__gate=");
    vi.useRealTimers();
  });

  it("renews the cookie on a normal page hit once it is 3/4 through its TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    // 走完 3/4 TTL 后再访问页面：应在页面响应里顺带续签，而不是弹回门禁页。
    vi.setSystemTime((1_700_000_000 + 2700 + 1) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            Cookie: cookie,
            "CF-Connecting-IP": "203.0.113.7",
            "Host": "limooo.cn",
          },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("<html>home</html>", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("__gate=");
    vi.useRealTimers();
  });

  it("does not renew on every page hit, so the hour is not a sliding window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const cookie = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    vi.setSystemTime((1_700_000_000 + 120) * 1000);

    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/", {
          headers: {
            Cookie: cookie,
            "CF-Connecting-IP": "203.0.113.7",
            "Host": "limooo.cn",
          },
        }),
        {
          ASSETS: {
            fetch: async () =>
              new Response("<html>home</html>", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
          },
        },
      ),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Set-Cookie") ?? "").not.toContain("__gate=");
    vi.useRealTimers();
  });

  it("caps how many same-name __gate cookies it will verify", async () => {
    // 同名 cookie 没有数量上限：每一个都要跑一次 regex + WebCrypto importKey + sign。
    // 32 KB 的 Cookie 头 ≈ 400 枚 ≈ 400 次 WebCrypto 调用，CPU 由攻击者决定
    // （docs/22 W9-10）。只取前 N 枚校验。
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const valid = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];
    const junk = `__gate=1700000000.1700003600.${"a".repeat(64)}`;

    // 上限之内的第一枚仍然有效（保留「旧作用域 cookie 排前面」的既有行为）。
    const withinCap = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: `${junk}; ${valid}`, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );
    expect(withinCap.status).toBe(302);

    // 有效 cookie 被埋在第 9 枚之后：超出的部分不再校验，因此不放行。
    const flood = Array.from({ length: 40 }, () => junk).join("; ");
    const beyondCap = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: `${flood}; ${valid}`, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );
    vi.useRealTimers();

    expect(beyondCap.status).toBe(403);
  });

  it("accepts the request when a stale __gate precedes a valid one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000 * 1000);
    const valid = (await mintGateCookie(keys.GATE_HMAC_KEY)).split(";")[0];

    // 旧作用域里那枚已失效的 __gate 排在前面；只看第一枚就会被它挡掉。
    const stale = `__gate=1700000000.1700003600.${"a".repeat(64)}`;
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate?host=limooo.cn&next=%2Fservices", {
          headers: { Cookie: `${stale}; ${valid}`, "CF-Connecting-IP": "203.0.113.7" },
        }),
        assetsEnv,
      ),
    );
    vi.useRealTimers();

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/services");
  });

  it("never lets the challenge page be cached at the content URL", async () => {
    const resp = await handleOnRequest(
      context(new Request("https://limooo.cn/services"), assetsEnv),
    );
    expect(resp.status).toBe(403);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  it("308s the legacy /__gate entry to /gate, preserving the query", async () => {
    const resp = await handleOnRequest(
      context(
        new Request("https://limooo.cn/__gate?host=limooo.cn&next=%2Fservices"),
        assetsEnv,
      ),
    );

    expect(resp.status).toBe(308);
    expect(resp.headers.get("Location")).toBe(
      "https://limooo.cn/gate?host=limooo.cn&next=%2Fservices",
    );
  });

  it("answers the canonical config/diag/verify endpoints", async () => {
    const config = await handleOnRequest(
      context(new Request("https://limooo.cn/gate/config")),
    );
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toHaveProperty("root_domain", "limooo.cn");

    const diag = await handleOnRequest(
      context(
        new Request("https://limooo.cn/gate/diag", {
          headers: { "CF-Connecting-IP": "203.0.113.7" },
        }),
      ),
    );
    expect(diag.status).toBe(200);
  });
});

describe("onRequest wrapper", () => {
  /**
   * onRequest 的埋点走 context.waitUntil：用一个收集数组把延后的 promise 拿回来，
   * 既能等它们跑完，也能断言它们确实交给了 waitUntil（而不是被 fire-and-forget）。
   */
  function wrapperContext(
    request: Request,
    env: Partial<Env> = {},
    next: () => Promise<Response> = async () => new Response("next", { status: 200 }),
  ) {
    const deferred: Promise<unknown>[] = [];
    const context: RequestContext = {
      request,
      env: { ...keys, ...env } as Env,
      next,
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
    };
    return { context, deferred };
  }

  const htmlEnv = (body = "<html><body>{{host}} {{next}}</body></html>") => ({
    ASSETS: {
      fetch: async () =>
        new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    },
  });

  /**
   * 造一个「workerd 语义」的响应：迭代（`new Headers(resp.headers)` 走的路径）
   * 只看到逗号合并后的一条 `set-cookie`，而 `getSetCookie()` 仍给出两条。
   *
   * Node/undici 的复制构造函数会原样保留多条 Set-Cookie，所以不模拟这一层，
   * 把 `preserveSetCookie` 删掉也不会红——而线上跑的是 workerd。
   */
  function foldingCookieResponse(cookies: string[], status = 200): Response {
    const real = new Headers({ "Content-Type": "application/json" });
    for (const cookie of cookies) real.append("Set-Cookie", cookie);
    const resp = new Response("{}", { status, headers: real });
    Object.defineProperty(resp, "headers", {
      value: {
        getSetCookie: () => real.getSetCookie(),
        *[Symbol.iterator]() {
          yield ["content-type", "application/json"] as [string, string];
          yield ["set-cookie", real.getSetCookie().join(", ")] as [string, string];
        },
      },
    });
    return resp;
  }

  beforeEach(() => {
    vi.mocked(shouldTrackVisit).mockReturnValue(true);
    vi.mocked(shouldTrackRay).mockReturnValue(true);
    vi.mocked(recordVisit).mockClear();
    vi.mocked(recordRay).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(shouldTrackVisit).mockReturnValue(false);
    vi.mocked(shouldTrackRay).mockReturnValue(false);
  });

  it("adds the full security header set to pages and only nosniff to /api/*", async () => {
    const { context: pageContext } = wrapperContext(
      new Request("https://limooo.cn/services", {
        headers: { "CF-Connecting-IP": "97.64.18.11" },
      }),
      htmlEnv("<html>services</html>"),
    );
    const page = await onRequest(pageContext);

    expect(page.status).toBe(200);
    // 页面：SECURITY_HEADERS 逐条相等，值从唯一来源导入，不抄字符串。
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(page.headers.get(name), `${name} on a page`).toBe(value);
    }
    expect(page.headers.get("Content-Security-Policy")).toBe(
      SECURITY_HEADERS["Content-Security-Policy"],
    );

    const { context: apiContext } = wrapperContext(
      new Request("https://limooo.cn/api/visitors", {
        headers: { "CF-Connecting-IP": "97.64.18.11" },
      }),
    );
    const api = await onRequest(apiContext);

    expect(api.status).toBe(200);
    // /api/*：唯一例外是 nosniff，其余四个（含 CSP）不得出现，否则会破坏 JSON 接口。
    expect(api.headers.get("X-Content-Type-Options")).toBe(
      SECURITY_HEADERS["X-Content-Type-Options"],
    );
    expect(api.headers.get("Content-Security-Policy")).toBeNull();
    for (const name of Object.keys(SECURITY_HEADERS)) {
      if (name === "X-Content-Type-Options") continue;
      expect(api.headers.get(name), `${name} must not be added to /api/*`).toBeNull();
    }
  });

  it("keeps both Set-Cookie headers that /gate/verify issues", async () => {
    // /gate/verify 刻意下发两枚 Set-Cookie：先清 host-only 旧作用域，再写域级新
    // cookie（只写一条解不开旧 cookie 的遮挡）；多条被折叠时 Safari 只认第一条。
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: true, hostname: "limooo.cn", action: GATE_TURNSTILE_ACTION }),
    );

    const { context } = wrapperContext(
      new Request("https://limooo.cn/gate/verify", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.7",
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          "cf-turnstile-response": "token",
          next: "/",
          host: "limooo.cn",
        }).toString(),
      }),
    );
    const resp = await onRequest(context);

    expect(resp.status).toBe(204);
    const cookies = resp.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => cookie.startsWith("__gate="))).toBe(true);
    // 两条内容不同：一条 Max-Age=0 的清旧作用域，一条带签名的新 cookie。
    expect(new Set(cookies).size).toBe(2);
  });

  it("does not fold multiple Set-Cookie headers when rewrapping the response", async () => {
    // 走 next() 的多 cookie 响应（如 API 同时下发会话与 CSRF）真实穿过 onRequest；
    // 响应头按 workerd 的语义构造，见 foldingCookieResponse。
    const cookies = [
      "limooo_session=abc; Path=/; HttpOnly",
      "limooo_csrf=def; Path=/; SameSite=Lax",
    ];
    const { context } = wrapperContext(
      new Request("https://limooo.cn/api/auth/status", {
        headers: { "CF-Connecting-IP": "97.64.18.11" },
      }),
      {},
      async () => foldingCookieResponse(cookies),
    );

    const resp = await onRequest(context);

    expect(resp.status).toBe(200);
    expect(resp.headers.getSetCookie()).toEqual(cookies);
  });

  it("skips visit and ray tracking for 403 gate rejections", async () => {
    const { context, deferred } = wrapperContext(
      new Request("https://limooo.cn/services", {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
      htmlEnv(),
    );
    const resp = await onRequest(context);
    await Promise.all(deferred);

    expect(resp.status).toBe(403);
    // 门禁拒绝（与已封来源同样是 403）不落访问/Ray 日志，扫描流量不能反烧 D1 配额。
    // 埋点开关在 beforeEach 里已置 true，所以这两个 not.toHaveBeenCalled 不是空转。
    expect(vi.mocked(recordVisit)).not.toHaveBeenCalled();
    expect(vi.mocked(recordRay)).not.toHaveBeenCalled();
  });

  it("records the visit and ray on tracked responses, handing both to waitUntil", async () => {
    const { context, deferred } = wrapperContext(
      new Request("https://limooo.cn/services", {
        headers: { "CF-Connecting-IP": "97.64.18.11" },
      }),
      htmlEnv("<html>services</html>"),
    );
    const resp = await onRequest(context);
    await Promise.all(deferred);

    expect(resp.status).toBe(200);
    expect(vi.mocked(recordVisit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRay)).toHaveBeenCalledTimes(1);

    // 状态码按实际响应传下去，不写死。
    expect(vi.mocked(recordVisit).mock.calls[0][2]).toBe(200);
    const rayCall = vi.mocked(recordRay).mock.calls[0];
    expect(rayCall[2]).toBe(200);
    expect(typeof rayCall[3]).toBe("number");

    // 埋点 promise 必须交给 waitUntil：既不阻塞响应，也不是 fire-and-forget。
    expect(deferred).toContain(vi.mocked(recordVisit).mock.results[0].value);
    expect(deferred).toContain(vi.mocked(recordRay).mock.results[0].value);
  });
});

/**
 * docs/22 增量 ②：一条请求链路上 `new URL(request.url)` 只解析一次、
 * `detectLang` 只算一次。
 *
 * 计数用代理/取值器直接盯着 `request.url` 与 `Accept-Language` 的读取次数：
 * 前者就是 URL 解析次数，后者在无语言 cookie 的请求上就等于 detectLang 调用次数
 * （全站只有 routing.detectLang 读这个头）。改动前分别是 5 次与 2 次。
 */
describe("request URL is parsed once per request", () => {
  function countingRequest(url: string, cookie?: string) {
    const real = new Request(url, {
      headers: {
        "CF-Connecting-IP": "97.64.18.11",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const reads = { url: 0, acceptLanguage: 0 };
    Object.defineProperty(real, "url", {
      get() {
        reads.url += 1;
        return url;
      },
    });
    Object.defineProperty(real, "headers", {
      value: new Proxy(real.headers, {
        get(target, prop) {
          if (prop === "get") {
            return (name: string) => {
              if (name.toLowerCase() === "accept-language") reads.acceptLanguage += 1;
              return target.get(name);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    return { request: real, reads };
  }

  function run(request: Request) {
    const deferred: Promise<unknown>[] = [];
    return onRequest({
      request,
      env: {
        ...keys,
        ASSETS: {
          fetch: async () =>
            new Response("<html>services</html>", {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
        },
      } as Env,
      next: async () => new Response("next", { status: 200 }),
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
    });
  }

  it("parses the URL once and detects the language once for a page request", async () => {
    const { request, reads } = countingRequest("https://limooo.cn/services");
    const resp = await run(request);

    expect(resp.status).toBe(200);
    expect(reads.url).toBe(1);
    // 中间件算过一次语言后要沿 withLangCookie/renderGatePage 复用，不能再算第二遍。
    expect(reads.acceptLanguage).toBe(1);
  });

  it("still detects the language when the visitor already has a language cookie", async () => {
    const { request, reads } = countingRequest(
      "https://limooo.cn/services",
      "user_lang_preference=ja-jp",
    );
    const resp = await run(request);

    expect(resp.status).toBe(200);
    expect(reads.url).toBe(1);
    // 已有 cookie：一次都不必再检测（旧实现同样如此，这里锁住不倒退）。
    expect(reads.acceptLanguage).toBe(0);
  });
});

/**
 * `cachedPageAsset` 直接把 ASSETS 的 body 流透传（docs/22 增量 ⑤）。
 *
 * 这里锁三件事：响应**字节**逐字节不变、状态码/全部响应头逐项不变、
 * `cache.put` 仍然发生并且拿到的是同一份字节（tee 两条分支都能读完）。
 * 字节里故意混入 NUL、0xFF 与多字节 UTF-8：任何「按字符串重建」的写法都会露馅。
 */
describe("cachedPageAsset passes the asset body through", () => {
  const BYTES = new Uint8Array([
    0x3c, 0x21, 0x64, 0x6f, 0x63, 0x74, 0x79, 0x70, 0x65, 0x3e, 0x0a, 0x00, 0xff, 0xe4, 0xb8, 0xad,
    0xf0, 0x9f, 0x8e, 0x89, 0x0a, 0x7b, 0x7d, 0x0a,
  ]);
  const ASSET_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(BYTES.length),
    ETag: '"v1"',
  };

  function stubCaches() {
    const puts: Array<{ key: string; bytes: Uint8Array }> = [];
    const hits: Response[] = [];
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async () => hits.shift(),
        put: async (req: RequestInfo | URL, resp: Response) => {
          const key = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
          puts.push({ key, bytes: new Uint8Array(await resp.arrayBuffer()) });
        },
      },
    };
    return {
      puts,
      hits,
      restore: () => {
        (globalThis as { caches?: unknown }).caches = original;
      },
    };
  }

  function assetsEnv(body: BodyInit | null = BYTES, status = 200) {
    const fetch = vi.fn(async () =>
      new Response(body, { status, statusText: status === 200 ? "OK" : "Not Found", headers: ASSET_HEADERS }),
    );
    return { fetch } as unknown as Env["ASSETS"];
  }

  function pageRequest(headers: Record<string, string> = {}) {
    return new Request("https://limooo.cn/services", {
      headers: { "CF-Connecting-IP": "97.64.18.11", ...headers },
    });
  }

  it("returns the exact asset bytes and headers, and still fills the cache", async () => {
    const caches = stubCaches();
    const assets = assetsEnv();
    try {
      const resp = await handleOnRequest(
        context(pageRequest({ Cookie: "user_lang_preference=zh-cn" }), { ASSETS: assets }),
      );

      expect(resp.status).toBe(200);
      expect(resp.statusText).toBe("OK");
      // 页面缓存头是覆盖后的值，其余响应头逐项从 ASSETS 搬过来。
      expect(resp.headers.get("Cache-Control")).toBe(
        "public, max-age=300, stale-while-revalidate=3600",
      );
      expect(resp.headers.get("Vary")).toBe("Accept-Language");
      expect(resp.headers.get("Content-Type")).toBe(ASSET_HEADERS["Content-Type"]);
      expect(resp.headers.get("Content-Length")).toBe(ASSET_HEADERS["Content-Length"]);
      expect(resp.headers.get("ETag")).toBe(ASSET_HEADERS.ETag);

      // 字节逐字节相同（含 NUL / 0xFF / 4 字节 UTF-8）。
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(BYTES);

      // 已有语言 cookie：不补 Set-Cookie，且缓存写入仍然发生、拿到同一份字节。
      expect(resp.headers.getSetCookie()).toEqual([]);
      expect(caches.puts).toHaveLength(1);
      expect(caches.puts[0].bytes).toEqual(BYTES);
      expect(caches.puts[0].key).toContain("lang=zh-cn");
      expect(new URL(caches.puts[0].key).hostname).toBe("limooo.cn");
      expect(String(vi.mocked(assets.fetch).mock.calls[0][0])).toBe(
        "https://limooo.cn/zh-cn/services.html",
      );
    } finally {
      caches.restore();
    }
  });

  it("keeps the language Set-Cookie (single header, multiple semantics) on a first visit", async () => {
    const caches = stubCaches();
    try {
      const resp = await handleOnRequest(context(pageRequest(), { ASSETS: assetsEnv() }));

      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(BYTES);
      const cookies = resp.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain("user_lang_preference=en-us");
      // 首访会补 Set-Cookie，因此这次刻意不写缓存（与改动前一致）。
      expect(caches.puts).toHaveLength(0);
    } finally {
      caches.restore();
    }
  });

  it("does not fill the cache for a failed asset fetch", async () => {
    const caches = stubCaches();
    const assets = assetsEnv("missing", 404);
    try {
      const resp = await handleOnRequest(
        context(pageRequest({ Cookie: "user_lang_preference=zh-cn" }), { ASSETS: assets }),
      );

      expect(caches.puts).toHaveLength(0);
      expect(vi.mocked(assets.fetch)).toHaveBeenCalledTimes(1);
      // 资产缺失时交回 next()（页面路由的既有行为），不是 404。
      await expect(resp.text()).resolves.toBe("next");
    } finally {
      caches.restore();
    }
  });

  it("serves a cache hit without touching ASSETS", async () => {
    const caches = stubCaches();
    const assets = assetsEnv();
    caches.hits.push(
      new Response(BYTES.slice(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    try {
      const resp = await handleOnRequest(
        context(pageRequest({ Cookie: "user_lang_preference=zh-cn" }), { ASSETS: assets }),
      );

      expect(resp.status).toBe(200);
      expect(new Uint8Array(await resp.arrayBuffer())).toEqual(BYTES);
      expect(vi.mocked(assets.fetch)).not.toHaveBeenCalled();
      expect(caches.puts).toHaveLength(0);
    } finally {
      caches.restore();
    }
  });
});
