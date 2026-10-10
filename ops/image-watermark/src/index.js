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
 * image-watermark —— image.limooo.cn 图片水印 Worker（A2 归一化代理）
 *
 * A2（原图彻底不外发）后，公开 bundle 里：
 *   - /static/wm/portfolio/*  水印全图（原来就放在这里，旧缓存无害）
 *   - /static/portfolio/thumbs/*  干净缩略图（仅首页卡片用）
 *   - /static/qr-codes/*、/static/icons/*  干净资源
 *   作品集原始图不再对外发布（/static/portfolio/<图> 404）。
 *
 * Worker 职责：把 image.limooo.cn 收到的请求，按「逻辑路径」归一化后，
 * 永远回源到对应的公开静态资源（水印或干净版）；不做 Referer 判定，
 * 因为原始图已不存在于任何公开地址。规则：
 *   1. /portfolio/<图>（png/jpg/jpeg/webp，且不在 thumbs/ 子目录）
 *      → 永远返回水印变体 /static/wm/portfolio/<图>（无论来源）。
 *   2. 其他图片/资源（thumbs、qr-codes、icons）→ 返回干净静态版 /static/<路径>。
 *   3. 绝不代理 /api/*；非图片、非已知目录 → 404。
 *   4. 兼容 images.limooo.cn 风格的 /static/portfolio/... 路径（去掉 /static 前缀）。
 *
 * 缓存：按「回源 URL」走 Cache API，水印/干净版是不同 URL，天然互不污染。
 * 客户端响应只返回一份（A2 下无 Referer 差异化），因此不再带 Vary: Referer。
 */

const ORIGIN = "https://limooo.cn";
// image.limooo.cn 是资源归一化入口；访问域名根目录时交给可索引的图片门面页，
// 避免爬虫将裸域误判为软错误或 404。
const LANDING_PAGE = "https://images.limooo.cn/";

// 站点上实际使用的图片扩展名（与 public/static 暴露的内容一致）
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|avif|gif|bmp|ico|svg)$/i;

// 水印版只覆盖作品集根目录下的 png/jpg/jpeg/webp；thumbs 子目录不算。
const PORTFOLIO_ROOT_IMG_RE = /^\/portfolio\/[^/]+\.(png|jpe?g|webp)$/i;

// 允许的资源目录（杜绝代理 /api/* 与其他任意路径）
const KNOWN_DIR_RE = /^\/(?:portfolio|qr-codes|icons)(?:\/|$)/;

// 浏览器缓存 1 天（A2 下所有来源返回同一份，可放心共享缓存）
const CLIENT_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400";

// 水印变体版本号：改了水印外观（build.py 的生成参数）后 +1，
// 让 Worker 用新的回源 URL 绕过 CDN/本地缓存里的旧版水印图
const WM_VERSION = "3";

/** 去掉 images.limooo.cn 风格的 /static 前缀，得到逻辑路径。 */
export function logicalPath(pathname) {
  return pathname.startsWith("/static/")
    ? pathname.slice("/static".length)
    : pathname;
}

/** image.limooo.cn 的裸域统一跳转到公开图片门面页。 */
export function landingRedirect(url) {
  return url.pathname === "/" ? LANDING_PAGE : "";
}

/** 构造水印变体回源 URL（带版本参数，缓存破坏用）。 */
export function wmTarget(origin, pathname, search = "") {
  const u = new URL(origin + "/static/wm" + pathname + search);
  u.searchParams.set("__wmver", WM_VERSION);
  return u.toString();
}

/** 是否为作品集根目录下应加水印的图片（用于判断是否走水印变体）。 */
export function shouldWatermark(logical) {
  return PORTFOLIO_ROOT_IMG_RE.test(logical);
}

/**
 * 决定请求的回源目标。
 * 返回 { target, originalUrl?, watermarked, image }。
 * A2 下水印无 Referer 区分，因此不再需要 refererAllowed。
 */
export function routeFor(url, request, origin) {
  const base = origin || ORIGIN;
  const path = logicalPath(url.pathname);

  // 绝不放行 /api/*
  if (path.startsWith("/api/")) {
    return { target: "", watermarked: false, image: false };
  }

  // 作品集根目录图片：永远返回水印变体；若水印变体缺失直接 404，
  // 不回退到原图（原图已不公开，避免旧缓存里的干净原图被误当成回源）。
  if (PORTFOLIO_ROOT_IMG_RE.test(path)) {
    return {
      target: wmTarget(base, path, url.search),
      originalUrl: base + "/static/portfolio" + path + url.search,
      watermarked: true,
      image: true,
    };
  }

  // 其他图片/资源（thumbs、qr-codes、icons 及任意 /static 图片）：干净静态版
  if (IMAGE_PATH_RE.test(path)) {
    const clean = base + "/static" + path + url.search;
    return { target: clean, originalUrl: clean, watermarked: false, image: true };
  }

  // 非图片但位于已知资源目录（理论不会出现，容错回源干净静态版）
  if (KNOWN_DIR_RE.test(path)) {
    return {
      target: base + "/static" + path + url.search,
      watermarked: false,
      image: false,
    };
  }

  return { target: "", watermarked: false, image: false };
}

/** 组装发给客户端（浏览器）的响应。A2 下无 Referer 区分，不加 Vary: Referer。 */
function clientResponse(store, watermarked) {
  const headers = new Headers({
    "Content-Type": store.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": CLIENT_CACHE,
    "Access-Control-Allow-Origin": "*",
    "X-Limooo-Watermark": watermarked ? "1" : "0",
  });
  const etag = store.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  return new Response(store.body, { status: store.status, headers });
}

/** HEAD 请求：与 GET 相同的路由决策，只返回头部。 */
async function headResponse(request, origin) {
  const url = new URL(request.url);
  const route = routeFor(url, request, origin);
  if (!route.target) {
    return new Response(null, { status: 404, headers: { "X-Limooo-Watermark": "0" } });
  }
  const resp = await fetch(route.target, { method: "HEAD" });
  const headers = new Headers({
    "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": CLIENT_CACHE,
    "X-Limooo-Watermark": route.watermarked ? "1" : "0",
  });
  return new Response(null, { status: resp.status, headers });
}

/**
 * 回源并缓存：Cache API key 用回源 URL；水印/干净版是不同 URL，互不污染。
 */
async function proxyAndCache(originUrl, ctx, watermarked) {
  const cacheRequest = new Request(originUrl, { method: "GET" });
  const cached = await caches.default.match(cacheRequest);
  if (cached) return clientResponse(cached, watermarked);

  const originResp = await fetch(originUrl, {
    headers: { Accept: "*/*" },
  });
  if (!originResp.ok) {
    return new Response(originResp.body, originResp);
  }

  const buf = await originResp.arrayBuffer();
  const store = new Response(buf, {
    status: originResp.status,
    headers: {
      "Content-Type": originResp.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "ETag": originResp.headers.get("ETag") || "",
      "Last-Modified": originResp.headers.get("Last-Modified") || "",
    },
  });
  ctx.waitUntil(caches.default.put(cacheRequest, store.clone()));
  return clientResponse(store, watermarked);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ORIGIN || ORIGIN;

    const landing = landingRedirect(url);
    if (landing) return Response.redirect(landing, 301);

    // HEAD：同 GET 决策，只回头部
    if (request.method === "HEAD") {
      return headResponse(request, origin);
    }
    // 其他非 GET 方法直接透传到同路径（仍走干净静态，不做水印判定）
    if (request.method !== "GET") {
      return fetch(origin + url.pathname + url.search, { method: request.method });
    }

    const route = routeFor(url, request, origin);
    if (!route.target) return new Response("Not Found", { status: 404 });
    if (!route.image) return fetch(route.target);

    const resp = await proxyAndCache(route.target, ctx, route.watermarked);
    // 水印变体缺失（尚未重新构建）时直接 404，不回退原图，避免干净原图外泄
    if (route.watermarked && resp.status === 404) return resp;
    return resp;
  },
};
