/** 强制主题挑战门禁编排测试：必须无视白名单 IP / cf_clearance，并保持原 URL。 */

import { describe, expect, it, vi } from "vitest";
import { handleOnRequest, pageCacheKey } from "./_middleware";
import { mintGateCookie } from "./_lib/gate";
import type { Env } from "./_lib/env";
import type { RequestContext } from "./_lib/routing";

vi.mock("./_lib/tracking", () => ({
  isTrustedCrawler: () => false,
  recordRay: () => Promise.resolve(),
  recordVisit: () => Promise.resolve(),
  shouldTrackRay: () => false,
  shouldTrackVisit: () => false,
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
