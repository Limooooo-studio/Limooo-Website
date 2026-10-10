/** 请求路由 / 语言 / 站内跳转工具（无浏览器 DOM 依赖，可被 vitest 直接 import）。 */

import type { Env } from "./env";
import { contains, normalizeIp } from "./cidr";
import { GATE_TRUST_IPS, GATE_TRUST_NETWORKS } from "../_data/gateTrust";
import {
  BASE_URL,
  DEFAULT_LANG,
  LANG_COOKIE,
  LANG_COOKIE_MAX_AGE,
  PAGE_ROUTES,
  PUBLIC_HOSTS,
  ROOT_DOMAIN,
  SUPPORTED_LANGS,
} from "./config";

export interface RequestContext {
  request: Request;
  env: Env;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

/** 不能被门禁拦截的路径（否则死循环）。 */
export const SKIP_PATHS = new Set<string>([
  "/__gate/verify",
  "/__gate/diag",
  "/__gate/config",
  "/Limooo-xtext.svg",
  "/favicon.svg",
  // 登录链路：Entra 回调是来自 login.microsoftonline.com 的顶层跳转，
  // 不能因为 __gate cookie 恰好过期就被门禁页接管（否则登录直接断掉）。
  "/login/entra",
  "/login/callback",
]);

/** 门禁/封禁白名单：只认 data/whitelist.txt 生成的门禁信任配置。 */
export function isGateTrustedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (GATE_TRUST_IPS.has(normalized)) return true;
  return GATE_TRUST_NETWORKS.some(([network, prefix]) =>
    contains(network, Number(prefix), normalized),
  );
}

export function getCookie(name: string, header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        // Cookie 由客户端提供；畸形百分号编码不能让整个请求变成 500。
        return value;
      }
    }
  }
  return undefined;
}

/**
 * 请求方可控的回跳值里绝不允许出现的字符。
 *
 * C0 控制字符（含 CR/LF）与 DEL 一旦进入 `Location`，workerd 构造响应头时
 * 会抛 `TypeError` → 未捕获 500（门禁验证刚通过却拿不到 cookie）。同时
 * CR/LF 也是经典的响应头注入载荷，必须在唯一的收口处直接拒绝。
 */
const UNSAFE_NEXT_CHARS = /[\u0000-\u001f\u007f]/;

/** 只允许站内相对路径：以 / 开头、拒绝 //、反斜杠和任何协议前缀。 */
export function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "/";
  if (UNSAFE_NEXT_CHARS.test(raw)) return "/";
  return raw.slice(0, 2048);
}

/** 登录/登出回跳：站内相对路径，或仅允许 https + 白名单主机。 */
export function safeNextUrl(raw: string | null): string {
  const fallback = `${BASE_URL}/`;
  if (!raw || raw.length > 2048) return fallback;
  if (UNSAFE_NEXT_CHARS.test(raw)) return fallback;
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  try {
    const value = new URL(raw);
    if (value.protocol === "https:" && isPublicHost(value.hostname)) return raw;
  } catch {
    // 非 URL 一律回主站。
  }
  return fallback;
}

/** 门禁/登录回跳白名单：精确主机名，或配置里 *.limooo.cn 形式的通配子域。 */
export function isPublicHost(host: string): boolean {
  if (!host) return false;
  if (PUBLIC_HOSTS.has(host)) return true;
  for (const entry of PUBLIC_HOSTS) {
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true;
  }
  return false;
}

/** 门禁回跳目标主机只允许公开白名单，其余一律回主站。 */
export function sanitizeHost(raw: string | null | undefined): string {
  return raw && isPublicHost(raw) ? raw : ROOT_DOMAIN;
}

/**
 * 把要注入生成 HTML 的值转义（gate 页注入 host/next、redirect 页注入 to）。
 *
 * 原先 gate.ts 与 redirect.ts 各有一份逐字符相同的实现，收敛到这里；
 * 两处注入的都是**请求方可控**的值，漏转义即 XSS，因此只留一份。
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * 展示/日志用的访客 IP：只信 Cloudflare 写入的 `CF-Connecting-IP`。
 *
 * 历史上这里优先读 nginx 反代带上的 `X-Limooo-Client-IP` /
 * `X-Limooo-Client-Country`，但那套 VPS 已于 2026-09-17 退租，这两个头
 * **不再有可信来源**——任何访客自带即被采信，会污染 `visitor_rollups` 的
 * IP 哈希 / 国家 / `ip_enc`（后台"查看访客 IP"解出的就是攻击者自报的地址）、
 * 结构化日志，以及 Turnstile siteverify 的 `remoteip`。现已删除。
 *
 * 这两个函数只用于「展示、埋点、Turnstile remoteip」，**绝不能**喂给
 * isGateTrustedIp / isBlocked 之类的信任判定；调用方自带同名头一律无效。
 */
export function clientIpForLogs(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "";
}

/** 展示/日志用的访客国家码：只取 Cloudflare 判定的 `request.cf.country`。 */
export function clientCountryForLogs(request: Request): string {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  return cf?.country ?? "";
}

type SupportedLang = (typeof SUPPORTED_LANGS)[number];

/** 语言码的主语言子标签：语言码的第一段（如 zh 部分）。 */
function primarySubtag(lang: string): string {
  return lang.split("-")[0];
}

/** 语言码的地区子标签大写形式（如 CN）；没有地区段时返回空串。 */
function regionSubtag(lang: string): string {
  const parts = lang.split("-");
  return parts.length > 1 ? parts[1].toUpperCase() : "";
}

/**
 * 语言检测：cookie > Accept-Language（按契约 supported_langs 匹配）> CF 地区 > 契约默认语言。
 *
 * 这里**不写任何语言码字面量**：契约是唯一事实源，加一门语言只需改
 * `config-contract.json` 的 `supported_langs`——Accept-Language 前缀匹配
 * （Accept-Language 的首段命中 supported_langs 的首段）与国家码匹配（地区段相同）
 * 都从语言码自身的子标签推出来。
 * 兜底值同样取契约的 DEFAULT_LANG：历史实现把它写死成一个语言码字面量，
 * 于是改契约对边缘行为零影响。
 */
export function detectLang(request: Request): SupportedLang {
  const host = (request.headers.get("Host") ?? new URL(request.url).hostname).split(":")[0];
  // 语言 cookie 以 Domain=.limooo.cn 下发，全站共享：主域与所有子域（含
  // visitor / account / status / images 等）都读同一份，切语言后跨子域一致。
  if (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)) {
    const cookie = getCookie(LANG_COOKIE, request.headers.get("Cookie"));
    if (cookie && SUPPORTED_LANGS.includes(cookie.toLowerCase() as SupportedLang)) {
      return cookie.toLowerCase() as SupportedLang;
    }
  }

  const accept = request.headers.get("Accept-Language") ?? "";
  for (const part of accept.split(",")) {
    const tag = part.trim().split(";")[0].toLowerCase();
    if (!tag) continue;
    const exact = SUPPORTED_LANGS.find((lang) => lang === tag);
    if (exact) return exact as SupportedLang;
    const primary = primarySubtag(tag);
    const byPrefix = SUPPORTED_LANGS.find((lang) => primarySubtag(lang) === primary);
    if (byPrefix) return byPrefix as SupportedLang;
  }

  const country = clientCountryForLogs(request).toUpperCase();
  if (country) {
    const byCountry = SUPPORTED_LANGS.find((lang) => regionSubtag(lang) === country);
    if (byCountry) return byCountry as SupportedLang;
  }
  return DEFAULT_LANG as SupportedLang;
}

/** 语言 cookie（跨 .<root_domain> 子域共享）。 */
export function langCookieHeader(host: string, lang: string): string {
  const bareHost = host.split(":")[0] ?? "";
  const domain =
    bareHost === ROOT_DOMAIN || bareHost.endsWith(`.${ROOT_DOMAIN}`)
      ? `Domain=.${ROOT_DOMAIN}; `
      : "";
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax; Secure; ${domain}`;
}

/** 复制响应头时保留多条 Set-Cookie，避免 Safari 只认第一条。 */
export function preserveSetCookie(headers: Headers, source: Headers): void {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(source) : [];
  if (!cookies.length) return;
  headers.delete("Set-Cookie");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
}

/** 首次访问时把检测出的语言写回；不能原地修改不可变响应头。 */
export function withLangCookie(request: Request, resp: Response): Response {
  if (getCookie(LANG_COOKIE, request.headers.get("Cookie"))) return resp;
  const headers = new Headers(resp.headers);
  preserveSetCookie(headers, resp.headers);
  headers.append("Set-Cookie", langCookieHeader(request.headers.get("Host") ?? "", detectLang(request)));
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function normalizedPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** 主机+路径 → 应吐出的语言页面资产；静态资源等返回 null，交回 next()。 */
export function pageAsset(host: string, pathname: string, lang: string): string | null {
  const file = PAGE_ROUTES[host]?.[normalizedPath(pathname)];
  return file ? `/${lang}/${file}` : null;
}

/**
 * 免人机验证的公开文件目录：`src/static/files/` 随构建镜像到
 * `public/static/files/`，这里额外暴露成干净 URL `/files/<文件名>`
 * （limooo.cn 与 images.limooo.cn 都可用），供站外直接引用，不进门禁。
 */
export const PUBLIC_FILES_PREFIX = "/files/";

/** 是否属于公开静态资源/内部路径，避免门禁死循环和重复埋点。 */
export function isPublicAssetPath(pathname: string): boolean {
  return (
    SKIP_PATHS.has(pathname) ||
    pathname.startsWith("/static/") ||
    pathname.startsWith(PUBLIC_FILES_PREFIX) ||
    pathname === "/favicon.svg" ||
    pathname === "/Limooo-xtext.svg"
  );
}

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/**
 * 应用层封禁的豁免前缀：登录/登出/管理页，避免管理员从被封 IP 无法登录。
 *
 * 匹配必须是**精确路径或它的子路径**（`/account`、`/account/apple`），
 * 不能用 `startsWith("/account")`——那会把未来的 `/account-anything`
 * 一起放行，等于给攻击者一个免封禁前缀。调用方（中间件）只做这一处判定。
 */
export const EXEMPT_PATH_PREFIXES = [
  "/login",
  "/logout",
  "/account",
  "/visitor",
  "/api/apple-account",
  "/api/auth",
  "/api/ray",
] as const;

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
