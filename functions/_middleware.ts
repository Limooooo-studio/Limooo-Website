/**
 * Limooo Pages 中间件编排层。
 *
 * 本文件只负责请求编排、统一安全头和埋点时机；路由/门禁/跳转/封禁逻辑分别
 * 位于 _lib/routing.ts、_lib/gate.ts、_lib/redirect.ts、_lib/tracking.ts。
 */

import { logEvent } from "./_lib/logging";
import { configErrorResponse, requireAuth, runtimeConfigError } from "./_lib/session";
import { SECURITY_HEADERS } from "./_lib/security";
import {
  detectLang,
  getCookie,
  isGateTrustedIp,
  isApiPath,
  isExemptPath,
  isPublicAssetPath,
  PUBLIC_FILES_PREFIX,
  pageAsset,
  preserveSetCookie,
  withLangCookie,
  type RequestContext,
} from "./_lib/routing";
import {
  APPLE_ACCOUNT_HOSTNAME,
  BASE_URL,
  GATE_HOSTNAME,
  IMAGES_HOSTNAME,
  LANG_COOKIE,
  VISITOR_HOSTNAME,
  WWW_HOSTNAME,
} from "./_lib/config";
import {
  handleGateConfig,
  handleGateDiag,
  handleGateEntry,
  handleLegacyGateRedirect,
  gateCookieHeaders,
  handleVerify,
  isBlocked,
  renderGatePage,
  resolveGateTrust,
} from "./_lib/gate";
import { isRedirectHost, renderRedirectPage } from "./_lib/redirect";
import {
  isTrustedCrawler,
  recordRay,
  recordVisit,
  shouldTrackRay,
  shouldTrackVisit,
} from "./_lib/tracking";

type PagesFunction = (context: RequestContext) => Promise<Response>;

/**
 * 把 `/files/<名>` 映射到构建产物 `/static/files/<名>`，公开直出。
 *
 * 只接受单层、无点号跳转的文件名，避免 `/files/../secrets` 之类的越权读取；
 * 目录本身不列目录，不存在就 404。
 */
async function servePublicFile(
  context: RequestContext,
  pathname: string,
): Promise<Response> {
  const name = pathname.slice(PUBLIC_FILES_PREFIX.length);
  if (!name || name.includes("/") || name.includes("..") || name.startsWith(".")) {
    return new Response("Not Found", { status: 404 });
  }
  if (!context.env.ASSETS) return new Response("Not Found", { status: 404 });

  const asset = await context.env.ASSETS.fetch(
    new URL(`/static/files/${name}`, BASE_URL),
  );
  if (!asset.ok) return new Response("Not Found", { status: 404 });

  return new Response(asset.body, {
    status: 200,
    headers: {
      "Content-Type":
        asset.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
      ...(asset.headers.get("ETag") ? { ETag: asset.headers.get("ETag")! } : {}),
    },
  });
}

/** 非业务日志必须在响应返回后写入，不能阻塞页面/跳转。 */
function defer(context: RequestContext, promise: Promise<unknown>): void {
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
  } else {
    void promise;
  }
}

/**
 * 公开预渲染页面的缓存头——**按实测事实写，不写期望**。
 *
 * 2026-10-11 线上实测：同一 URL 连续三次请求，`cf-cache-status` 恒为 `DYNAMIC`、
 * `age` 恒为 0——Pages Functions 的响应**不参与 Cloudflare 边缘缓存**，写不写
 * `s-maxage`、`Vary` 怎么写都一样。所以这里不声明 `s-maxage`，`Vary` 里也不放
 * `Cookie`：那只是给每个访客开一个缓存桶（正是它让"边缘按 cookie 分桶"这句注释
 * 与事实相反），对边缘零收益。
 *
 * 保留 `max-age=300` 是因为**浏览器私有缓存**确实会用它，而 HTML 依赖
 * `Accept-Language`，所以保留 `Vary: Accept-Language` 让浏览器按语言分桶。
 * 真正的请求级复用来自下面的进程内 Cache API（键含 host + lang + 资产路径）。
 */
const PAGE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const PAGE_CACHE_VARY = "Accept-Language";

type CacheLike = {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
};

/**
 * 进程内 Cache API 的缓存键：**host + 语言 + 资产路径**。
 *
 * host 必须进键：`www.<root_domain>` 与主域的路由表逐条相同（见契约 page_routes），
 * 只要哪天把 pageAsset 的调用扩展到 www，或者两个主机映射到同一份资产，
 * 不带 host 的键就会让它们互相串页。当前 www 在到达缓存前已 301，
 * 属预防性修复——用测试把这条语义锁死。
 */
export function pageCacheKey(host: string, assetPath: string, lang: string): URL {
  const url = new URL(assetPath, BASE_URL);
  url.searchParams.set("__cache", "1");
  url.searchParams.set("lang", lang);
  if (host) url.hostname = host;
  return url;
}

/** 按 host + 语言缓存预渲染页面，避免每次请求都重复读取 ASSETS。 */
async function cachedPageAsset(
  context: RequestContext,
  assetPath: string,
  lang: string,
): Promise<Response | null> {
  const { env, request } = context;
  if (!env.ASSETS) return null;

  const host = new URL(request.url).hostname;
  const cacheUrl = pageCacheKey(host, assetPath, lang);
  const cache = typeof caches !== "undefined"
    ? (caches as unknown as { default?: CacheLike }).default
    : undefined;

  if (cache) {
    const hit = await cache.match(new Request(cacheUrl));
    if (hit) return hit;
  }

  const asset = await env.ASSETS.fetch(new URL(assetPath, BASE_URL));
  if (!asset.ok) return asset;

  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", PAGE_CACHE_CONTROL);
  headers.set("Vary", PAGE_CACHE_VARY);
  const response = new Response(await asset.arrayBuffer(), {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });

  // 首次访问还没有语言 cookie 时会补 Set-Cookie，因此只缓存后续请求。
  if (cache && getCookie(LANG_COOKIE, request.headers.get("Cookie"))) {
    const put = cache.put(new Request(cacheUrl), response.clone());
    context.waitUntil?.(put);
    if (!context.waitUntil) void put;
  }
  return response;
}

/** 统一注入安全响应头；API 只加 nosniff，避免破坏 JSON 接口。 */
export function withSecurityHeaders(request: Request, resp: Response): Response {
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  const isApi = new URL(request.url).pathname.startsWith("/api/");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (isApi && name !== "X-Content-Type-Options") continue;
    headers.set(name, value);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/**
 * 受保护子域未登录 → 落到本域的 /login 建立会话（docs/17 §11.10）。
 *
 * Access 已经在本域之前完成了身份认证（请求头带 `Cf-Access-Jwt-Assertion`），
 * 这里只是把 Access 身份换成我们的签名会话 cookie。回到**本域**的 /login
 * 而不是跨域跳 identity：会话 cookie 是 `.limooo.cn` 域级 cookie，
 * 同域往返少一跳，也不会在 Safari 上丢 cookie。
 */
async function adminAuthRedirect(
  env: RequestContext["env"],
  request: Request,
  hostname: string,
): Promise<Response | null> {
  if (hostname !== VISITOR_HOSTNAME && hostname !== APPLE_ACCOUNT_HOSTNAME) return null;
  try {
    if (await requireAuth(env, request)) return null;
    const url = new URL(request.url);
    const next = `${url.pathname}${url.search}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?next=${encodeURIComponent(next)}`,
      },
    });
  } catch {
    return Response.json(
      { error: "auth_sessions_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** 取回验证完成后应显示的原路径，移除仅供触发强制验证的参数。 */
function gateNextPath(pathname: string, search: string): string {
  const nextUrl = new URL(pathname + search, BASE_URL);
  nextUrl.searchParams.delete("challenge");
  return nextUrl.pathname + nextUrl.search;
}

/**
 * 会话临近到期时，在正常页面响应上顺带续签 __gate cookie。
 *
 * 续期由 resolveGateTrust 的 shouldRenew 决定（走完 3/4 TTL 才续一次），
 * 因此这里不会把 cookie 变成每次请求都刷新的无限滑动窗口；不续期时
 * 原样返回响应，不做任何额外分配。
 */
async function renewGateCookie(
  context: RequestContext,
  resp: Response,
  shouldRenew: boolean,
): Promise<Response> {
  if (!shouldRenew) return resp;
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  for (const value of await gateCookieHeaders(context.env.GATE_HMAC_KEY)) {
    headers.append("Set-Cookie", value);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/** 中间件核心编排，导出供本地测试 mock 依赖。 */
export async function handleOnRequest(context: RequestContext): Promise<Response> {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const configError = runtimeConfigError(env);
  if (configError) return configErrorResponse(configError);
  const { hostname, pathname } = url;
  const forceChallenge = url.searchParams.get("challenge") === "1";

  // 运维健康端点：不记录访客、不经过人机门禁，供 Uptime Kuma 以探针 UA 访问。
  if (pathname === "/_health") {
    return new Response("ok\n", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // 应用层封禁的豁免名单：这些路径即使来自被封 IP 也必须可达，否则管理员
  // 从被封 IP 就再也登不进来/退不出去，只能等 Cloudflare IP List 的下一次同步。
  // 只匹配精确路径或它的子路径（routing.ts 的 isExemptPath）：宽前缀
  // `startsWith("/account")` 会把未来的 `/account-anything` 一起放行，
  // 等于给攻击者留一个免封禁前缀。
  const exempt = isExemptPath(pathname);
  const whitelisted = isGateTrustedIp(request.headers.get("CF-Connecting-IP") ?? "");
  // 信任判定的**廉价前段**：白名单 IP 或 Cloudflare verifiedBot。这里先算一次，
  // 让封禁检查能跳过已信任来源（两者都是纯函数/读请求头，不查库）。
  const sourceTrusted = whitelisted || isTrustedCrawler(request);

  // 公开静态资源与 API 必须先放行：跳转子域也共享 /static 资源，
  // 不能把 redirect.limooo.cn/static/css/... 也渲染成 Redirecting HTML。
  // （必须在封禁检查之前：静态资源与 /files/ 本来就不该为它查库。）
  if (isPublicAssetPath(pathname) || isApiPath(pathname)) {
    // 干净文件 URL `/files/<名>` → 构建产物 `/static/files/<名>`，
    // 公开、不经过人机门禁（images.limooo.cn 下也走这条）。
    if (pathname.startsWith(PUBLIC_FILES_PREFIX)) {
      return servePublicFile(context, pathname);
    }
    // `/api/*` 仍然要过封禁检查（W9-1）：只有静态资源、/files/，
    // 以及豁免路径/已信任来源的 API 直接返回。豁免路径不查库（也查不出结果）。
    if (!isApiPath(pathname)) return next();
  }

  /**
   * 应用层封禁检查（放行 exempt 名单，以及已信任来源）。
   *
   * 位置很关键，三条都不能退：
   * 1. 必须在 `/api/*` 的 `next()` **之前**。此前的写法把 `isApiPath` 的早返回
   *    放在检查之前，于是（除静态资源外的）全部 API 路径都绕过了封禁
   *    （`/api/visitors`、`/api/blocklist`、`/api/ray/<id>` …），exempt 里的
   *    三条 `/api/...` 也因此成了永远走不到的死条件；被封 IP 只能等每天 03:30
   *    的 D1→Cloudflare IP List 同步才真正被封，同步一失败就永不封。
   * 2. 已信任来源（白名单 IP、verifiedBot）直接跳过、不查库：一次检查最坏是
   *    33 个 IPv4 前缀探测（IPv6 129 个），让所有正常访客都照查是本审计里
   *    单项最大的固定读取开销（docs/22 W2-2）。
   * 3. 判据用 `sourceTrusted`（不含 cookieValid）：持 __gate 的普通访客仍受封禁约束。
   *
   * 豁免名单保留：被封 IP 也必须能访问 /login、/gate 等入口，否则只能等
   * Cloudflare IP List 的下一次同步才可能脱困。
   */
  const bannedIp = request.headers.get("CF-Connecting-IP") ?? "";
  if (
    !exempt &&
    !sourceTrusted &&
    bannedIp &&
    (await isBlocked(env, request, bannedIp))
  ) {
    return renderGatePage(context, {
      host: hostname,
      next: pathname + url.search,
      errorKey: "blocked",
    });
  }

  // `/api/*` 走完封禁检查后一律交回各自的 API 路由（旧行为）：豁免与已信任来源
  // 在上面就跳过了检查，非豁免来源只有「没命中封禁」才会落到这里。少了这一行，
  // 豁免的 API（/api/auth、/api/apple-account、/api/ray）会被后面的门禁判定接管，
  // 管理员从被封 IP 又登不进来了。
  if (isApiPath(pathname)) return next();

  // 跳转子域：纯中转页，豁免人机验证。
  if (isRedirectHost(hostname)) return renderRedirectPage(context);

  // 门禁接口与公开静态/API 路径不能被门禁拦截。
  if (pathname === "/__gate/verify" || pathname === "/gate/verify") return handleVerify(context);
  if (pathname === "/__gate/config" || pathname === "/gate/config") return handleGateConfig(context);
  if (pathname === "/__gate/diag" || pathname === "/gate/diag") return handleGateDiag(context);

  // 门禁页：/gate 是唯一对外入口，旧 /__gate 一律 308 到它。
  // 任意主机（对应域名）都能渲染/回跳，做到同域名完成 challenge。
  if (pathname === "/__gate") return handleLegacyGateRedirect(context);
  if (pathname === "/gate") return handleGateEntry(context);

  // 图片子域强制挑战直接在当前 URL 输出门禁页，地址栏不切到 /__gate。
  if (forceChallenge && hostname === IMAGES_HOSTNAME) {
    return renderGatePage(context, { host: hostname, next: gateNextPath(pathname, url.search) });
  }

  // images.<root_domain>：图片子域公开访问；页面路径吐门面页，其余映射 /static。
  if (hostname === IMAGES_HOSTNAME) {
    const lang = detectLang(request);
    const page = pageAsset(hostname, pathname, lang);
    if (page) {
      const resp = await cachedPageAsset(context, page, lang);
      if (resp?.ok) {
        return withLangCookie(request, resp);
      }
    }
    if (env.ASSETS) {
      const staticAsset = await env.ASSETS.fetch(new URL(`/static${pathname}`, BASE_URL));
      if (staticAsset.ok) {
        return new Response(staticAsset.body, {
          headers: {
            "Content-Type": staticAsset.headers.get("Content-Type") ?? "",
            "Cache-Control": "public, max-age=2592000",
            "ETag": staticAsset.headers.get("ETag") ?? "",
          },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  // www 保持原 nginx 行为：先 301 到主站（保留路径）。
  if (hostname === WWW_HOSTNAME) {
    return withLangCookie(request, new Response(null, {
      status: 301,
      headers: {
        Location: `${BASE_URL}${pathname}${url.search}`,
        "Cache-Control": "no-store",
      },
    }));
  }

  // 快速切换主题触发的强制挑战：即使来自中国大陆 ASN、白名单 IP、
  // 只有有效 __gate cookie 或经 Cloudflare verifiedBot 验证才放行；cf_clearance 不再作为绕过依据。
  if (forceChallenge) {
    defer(
      context,
      logEvent(env, "gate_redirect", request, {
        outcome: "forced",
        status: 403,
        path: pathname,
        message: "force_theme_challenge",
      }),
    );
    return renderGatePage(context, { host: hostname, next: gateNextPath(pathname, url.search) });
  }

  const trust = await resolveGateTrust(context);
  const gated = !(trust.trusted || trust.cookieValid);

  if (!gated) {
    if (trust.trusted) {
      defer(
        context,
        logEvent(env, "gate_bypass", request, {
          outcome: "trusted",
          status: 200,
          path: pathname,
          message: whitelisted ? "gate_whitelist" : "cf_verified_bot",
        }),
      );
    }

    const lang = detectLang(request);
    const asset = pageAsset(hostname, pathname, lang);
    if (asset) {
      const authRedirect = await adminAuthRedirect(env, request, hostname);
      if (authRedirect) return withLangCookie(request, authRedirect);
      const resp = await cachedPageAsset(context, asset, lang);
      if (resp?.ok) {
        // 会话临近到期时在响应里顺带续签，访客不会在浏览中途被弹回门禁页。
        return withLangCookie(request, await renewGateCookie(context, resp, trust.shouldRenew));
      }
    }
    // 门禁主机没有别的内容页：已验证访客也在原地渲染门禁页（200），
    // 既不落到 404，也不把人送去主站。
    if (hostname === GATE_HOSTNAME) {
      return renderGatePage(context, {
        host: hostname,
        next: pathname + url.search,
        passed: true,
      });
    }
    return withLangCookie(request, await renewGateCookie(context, await next(), trust.shouldRenew));
  }

  // 带了 __gate 却仍不放行：把校验结论落进 events，用于定位「验证成功又被拦」。
  // 只在这种异常态记录，正常首访（无 cookie）不写，避免无谓的 D1 写入。
  if (trust.cookiePresent) {
    defer(
      context,
      logEvent(env, "gate_stale_cookie", request, {
        outcome: "gated",
        status: 403,
        path: pathname,
        message: trust.cookieReason,
      }),
    );
  }

  // 未验证：直接在被访问的 URL 输出门禁页，地址栏始终保持原页面地址。
  return renderGatePage(context, { host: hostname, next: pathname + url.search });
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const startedAt = Date.now();
  const resp = withSecurityHeaders(request, await handleOnRequest(context));

  // 门禁拒绝与已封来源不落访问/Ray 日志，避免扫描流量反过来耗尽 D1 配额。
  const trackResponse = resp.status !== 403;
  if (trackResponse && shouldTrackVisit(request, url)) {
    if (typeof context.waitUntil === "function") {
      context.waitUntil(recordVisit(env, request, resp.status));
    } else {
      void recordVisit(env, request, resp.status);
    }
  }
  if (trackResponse && shouldTrackRay(request, url)) {
    const durationMs = Date.now() - startedAt;
    if (typeof context.waitUntil === "function") {
      context.waitUntil(recordRay(env, request, resp.status, durationMs));
    } else {
      void recordRay(env, request, resp.status, durationMs);
    }
  }
  return resp;
};
