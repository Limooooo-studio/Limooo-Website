/**
 * Cloudflare Access JWT 验签（docs/17 §11.6 / §11.10）。
 *
 * Access 前置在 Pages 之前，通过 `Cf-Access-Jwt-Assertion` 头（浏览器另有
 * `CF_Authorization` cookie）把已认证身份交给 Worker；**Worker 必须自行验签**
 * （官方文档 Validate JWTs），否则伪造请求头即可冒充管理员。
 *
 * 设计取舍：
 * - 本模块只负责「Access 身份 -> 本系统身份」。会话 cookie、D1 `auth_sessions`
 *   撤销表与 requireAuth 的 fail-closed 语义全部沿用 docs/09，不做改动。
 * - 角色由 **AUD** 决定：每个 Application 有唯一 AUD，除非删除重建否则永不变，
 *   是最可靠的授权依据（不需要自定义 claims）。
 * - team domain 与 AUD 走 Pages 环境变量，不写进 `config-contract.json`：
 *   Access 是纯边缘能力，构建产物里不应出现这些常量。
 */

import type { Env } from "./env";

export interface AccessIdentity {
  sub: string;
  email: string;
  role: "admin" | "viewer";
  expiresAt: number;
}

interface JwkLike {
  kid?: string;
  n?: string;
  e?: string;
  kty?: string;
  alg?: string;
  use?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface AccessClaims {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

const textEncoder = new TextEncoder();
const JWKS_TIMEOUT_MS = 8000;
const JWKS_TTL_MS = 3600_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_JWT_LENGTH = 16 * 1024;

let jwksCache: { url: string; keys: JwkLike[]; fetchedAt: number } | null = null;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** team domain，如 https://limooo.cloudflareaccess.com（缺失则返回空串）。 */
export function accessTeamDomain(env: Env): string {
  const raw = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  if (!raw) return "";
  return stripTrailingSlash(raw.startsWith("http") ? raw : `https://${raw}`);
}

export function accessJwksUrl(env: Env): string {
  const base = accessTeamDomain(env);
  return base ? `${base}/cdn-cgi/access/certs` : "";
}

export function accessLogoutUrl(env: Env, redirectUrl: string): string {
  const base = accessTeamDomain(env);
  if (!base) return redirectUrl;
  return `${base}/cdn-cgi/access/logout?redirect_url=${encodeURIComponent(redirectUrl)}`;
}

function parseAudList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 配置错误只返回字段名，绝不返回密钥值。 */
export function accessConfigError(env: Env): string | null {
  if (!accessTeamDomain(env)) return "missing_ACCESS_TEAM_DOMAIN";
  const auds = [...parseAudList(env.ACCESS_ADMIN_AUDS), ...parseAudList(env.ACCESS_VIEWER_AUDS)];
  if (!auds.length) return "missing_ACCESS_AUDS";
  return null;
}

function b64urlDecode(input: string): Uint8Array {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input) || input.length % 4 === 1) {
    throw new Error("invalid_base64url");
  }
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** WebCrypto 只接受 ArrayBuffer 支撑的视图；TS 的 Uint8Array 默认是 ArrayBufferLike。 */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function decodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(input))) as T;
}

/** AUD -> 角色；未命中任何配置时返回 null（调用方 fail closed）。 */
export function roleForAud(env: Env, aud: string | string[] | undefined): "admin" | "viewer" | null {
  const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
  if (!auds.length) return null;
  const admin = new Set(parseAudList(env.ACCESS_ADMIN_AUDS));
  const viewer = new Set(parseAudList(env.ACCESS_VIEWER_AUDS));
  for (const a of auds) {
    if (admin.has(a)) return "admin";
  }
  for (const a of auds) {
    if (viewer.has(a)) return "viewer";
  }
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取并缓存签名密钥。
 *
 * `force` 用于 kid 未命中时**绕过 TTL 重拉一次**：Cloudflare 每 6 周轮换签名
 * 密钥，缓存 1 h 内新 kid 完全不在手里。不重拉的话轮换后新 token 全部判无效
 * （`/login` 401、受保护子域无限 302），最长持续一小时。重拉失败时仍回退到
 * 旧缓存，不能因为一次网络抖动就让所有人登录失败。
 */
async function fetchJwks(env: Env, force = false): Promise<JwkLike[] | { error: string }> {
  const url = accessJwksUrl(env);
  if (!url) return { error: "missing_ACCESS_TEAM_DOMAIN" };
  if (
    !force &&
    jwksCache &&
    jwksCache.url === url &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  try {
    const resp = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/json", "User-Agent": "limooo-pages/1.0" } },
      JWKS_TIMEOUT_MS,
    );
    if (!resp.ok) return { error: `jwks_http_${resp.status}` };
    const body = (await resp.json()) as { keys?: JwkLike[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (!keys.length) return { error: "jwks_empty" };
    jwksCache = { url, keys, fetchedAt: Date.now() };
    return keys;
  } catch {
    // 拉取失败时回退到上一次的缓存：Cloudflare 每 6 周轮换签名密钥，
    // 轮换窗口内不能因为一次网络抖动就让所有人登录失败。
    if (jwksCache && jwksCache.url === url) return jwksCache.keys;
    return { error: "jwks_fetch_exception" };
  }
}

async function verifySignature(
  signingInput: string,
  signature: Uint8Array,
  key: JwkLike,
): Promise<boolean> {
  if (key.kty !== "RSA" || !key.n || !key.e) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RS256" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    copyBytes(signature),
    copyBytes(textEncoder.encode(signingInput)),
  );
}

/**
 * 校验 Access JWT。任何一步失败都返回 null（fail closed），不抛异常。
 *
 * 顺序刻意如此：**先验签再读 claims**，绝不用未验证的 payload 做任何判断。
 */
export async function verifyAccessJwt(
  env: Env,
  token: string | null | undefined,
): Promise<AccessIdentity | null> {
  if (!token || token.length > MAX_JWT_LENGTH) return null;
  const expectedIssuer = accessTeamDomain(env);
  if (!expectedIssuer) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: JwtHeader;
  try {
    header = decodeJson<JwtHeader>(parts[0]);
  } catch {
    return null;
  }
  // 只接受 RS256；显式拒绝 alg:none 与任何降级算法。
  if (header.alg !== "RS256") return null;

  const pickKey = (keys: JwkLike[]): JwkLike | undefined =>
    keys.find((item) => (header.kid ? item.kid === header.kid : item.kty === "RSA"));

  let jwks = await fetchJwks(env);
  if (!Array.isArray(jwks)) return null;
  let key = pickKey(jwks);
  if (!key && header.kid) {
    // kid 未命中：可能是 Cloudflare 刚轮换密钥，而我们的缓存还没过期。
    // 绕过 TTL 重拉一次再判定，避免轮换后的最长 1 小时登录中断。
    jwks = await fetchJwks(env, true);
    if (!Array.isArray(jwks)) return null;
    key = pickKey(jwks);
  }
  if (!key) return null;

  let signature: Uint8Array;
  try {
    signature = b64urlDecode(parts[2]);
  } catch {
    return null;
  }

  let signatureOk = false;
  try {
    signatureOk = await verifySignature(`${parts[0]}.${parts[1]}`, signature, key);
  } catch {
    return null;
  }
  if (!signatureOk) return null;

  let claims: AccessClaims;
  try {
    claims = decodeJson<AccessClaims>(parts[1]);
  } catch {
    return null;
  }

  if (stripTrailingSlash(String(claims.iss ?? "")) !== expectedIssuer) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof claims.iat === "number" && claims.iat > now + CLOCK_SKEW_SECONDS) return null;

  const role = roleForAud(env, claims.aud);
  if (!role) return null;

  const sub = String(claims.sub ?? "").trim();
  if (!sub) return null;
  const email = String(claims.email ?? "").trim();

  return {
    sub: `access:${sub}`,
    email: email || sub,
    role,
    expiresAt: claims.exp,
  };
}

/** 供 login.ts 读取 Access 注入的身份头。 */
export function accessAssertion(request: Request): string | null {
  return request.headers.get("Cf-Access-Jwt-Assertion");
}
