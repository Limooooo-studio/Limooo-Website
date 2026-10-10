/** 自研 HMAC 签名会话 cookie + D1 auth_sessions 撤销表（Pages 无内置 session） */

import { execute, queryAll } from "./d1";
import type { Env } from "./env";
import {
  PENDING_COOKIE,
  REVEAL_MAX_AUTH_AGE_SECONDS,
  ROOT_DOMAIN,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./config";
import { fromB64Url, hmacSha256Hex, timingSafeEqual, toB64Url } from "./crypto";

const textEncoder = new TextEncoder();
const COOKIE_DOMAIN = `.${ROOT_DOMAIN}`;
const AUTH_SESSION_TABLE = "auth_sessions";
const MAX_SIGNED_TOKEN_LENGTH = 8192;
const MAX_SESSION_FIELD_LENGTH = 512;

export interface SessionUser {
  email: string;
  name: string;
}

export interface SessionData {
  sid: string;
  sub: string;
  user: SessionUser;
  role: "admin" | "viewer";
  authAt: number;
}

interface SignedSession extends SessionData {
  exp: number;
}

interface AuthSessionRow {
  sid: string;
  sub: string;
  role: "admin" | "viewer";
  auth_at: number;
  exp: number;
  revoked_at: number | null;
}

export class AuthSessionUnavailableError extends Error {
  constructor(message = "auth_sessions_unavailable") {
    super(message);
    this.name = "AuthSessionUnavailableError";
  }
}

/**
 * 严格版 base64url 解码：比共用实现多一道字符集与长度校验。
 *
 * session token 由请求方提供，先挡掉畸形输入再解码，避免把异常当控制流。
 */
function fromB64UrlStrict(input: string): Uint8Array {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input) || input.length % 4 === 1) {
    throw new Error("invalid_base64url");
  }
  return fromB64Url(input);
}

function getCookie(name: string, header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function signPayload(key: string, payload: string): Promise<string> {
  return `${toB64Url(textEncoder.encode(payload))}.${await hmacSha256Hex(key, payload)}`;
}

async function verifyPayload<T>(key: string, token: string | undefined): Promise<T | null> {
  try {
    if (!key || !token || token.length > MAX_SIGNED_TOKEN_LENGTH) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    const payload = new TextDecoder().decode(fromB64UrlStrict(b64));
    const expected = await hmacSha256Hex(key, payload);
    if (!timingSafeEqual(sig, expected)) return null;
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookieHeader(name: string): string {
  return `${name}=; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64Url(value);
}

export async function createSessionCookie(env: Env, data: SessionData): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload: SignedSession = { ...data, exp };
  return cookieHeader(SESSION_COOKIE, await signPayload(env.SESSION_HMAC_KEY ?? "", JSON.stringify(payload)), SESSION_TTL_SECONDS);
}

export function clearSessionCookie(): string {
  return clearCookieHeader(SESSION_COOKIE);
}

export async function readSession(
  env: Env,
  cookieHeaderValue: string | null,
): Promise<SessionData | null> {
  const token = getCookie(SESSION_COOKIE, cookieHeaderValue);
  const data = await verifyPayload<SignedSession>(env.SESSION_HMAC_KEY ?? "", token);
  if (!data) return null;
  if (
    typeof data.exp !== "number" ||
    data.exp <= Math.floor(Date.now() / 1000) ||
    !Number.isSafeInteger(data.exp) ||
    typeof data.sid !== "string" ||
    data.sid.length === 0 || data.sid.length > MAX_SESSION_FIELD_LENGTH ||
    typeof data.sub !== "string" ||
    data.sub.length === 0 || data.sub.length > MAX_SESSION_FIELD_LENGTH ||
    !data.user ||
    typeof data.user.email !== "string" ||
    data.user.email.length === 0 || data.user.email.length > 254 ||
    typeof data.user.name !== "string" ||
    data.user.name.length > MAX_SESSION_FIELD_LENGTH ||
    !["admin", "viewer"].includes(data.role) ||
    !Number.isSafeInteger(data.authAt) || data.authAt < 0
  ) {
    return null;
  }
  return {
    sid: data.sid,
    sub: data.sub,
    user: { email: data.user.email, name: data.user.name },
    role: data.role,
    authAt: data.authAt,
  };
}

/**
 * 校验签名 cookie 后必须再查 D1 auth_sessions。表不存在或查不到时按
 * AuthSessionUnavailableError 抛出，由调用方返回 503，不能 fallback 到
 * 仅凭签名 cookie 放行。
 */
export async function requireAuth(env: Env, request: Request): Promise<SessionData | null> {
  const session = await readSession(env, request.headers.get("Cookie"));
  if (!session) return null;
  if (!env.DB) throw new AuthSessionUnavailableError();

  try {
    const rows = await queryAll<AuthSessionRow>(
      env.DB,
      `SELECT sid, sub, role, auth_at, exp, revoked_at
       FROM ${AUTH_SESSION_TABLE}
       WHERE sid = ? AND sub = ?`,
      session.sid,
      session.sub,
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.revoked_at != null) return null;
    if (Number(row.exp) <= Math.floor(Date.now() / 1000)) return null;
    if (row.sub !== session.sub || row.role !== session.role) return null;
    return session;
  } catch (error) {
    if (error instanceof AuthSessionUnavailableError) throw error;
    throw new AuthSessionUnavailableError(
      error instanceof Error ? error.message : "auth_sessions_unavailable",
    );
  }
}

export async function createAuthSession(env: Env, session: SessionData): Promise<boolean> {
  if (!env.DB || !session.sid || !session.sub) return false;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  try {
    return await execute(
      env.DB,
      `INSERT INTO ${AUTH_SESSION_TABLE}
        (sid, sub, role, auth_at, exp, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      session.sid,
      session.sub,
      session.role,
      session.authAt,
      exp,
    );
  } catch {
    return false;
  }
}

export async function revokeAuthSession(env: Env, sid: string): Promise<boolean> {
  if (!env.DB || !sid) return false;
  try {
    return await execute(
      env.DB,
      `UPDATE ${AUTH_SESSION_TABLE}
       SET revoked_at = unixepoch()
       WHERE sid = ? AND revoked_at IS NULL`,
      sid,
    );
  } catch {
    return false;
  }
}

export function clearPendingCookie(): string {
  return clearCookieHeader(PENDING_COOKIE);
}

/** 门禁/会话运行必需的密钥；只返回字段名，不回显值。 */
export function runtimeConfigError(env: Env): string | null {
  const missing: string[] = [];
  if (!env.TURNSTILE_SECRET?.trim()) missing.push("TURNSTILE_SECRET");
  if (!env.GATE_HMAC_KEY?.trim()) missing.push("GATE_HMAC_KEY");
  if (!env.SESSION_HMAC_KEY?.trim()) missing.push("SESSION_HMAC_KEY");
  return missing.length ? `missing_${missing.join("_")}` : null;
}

export function configErrorResponse(reason: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>503</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem">
  <h1>503 Service Configuration Error</h1>
  <p>Service configuration is incomplete. Please contact the administrator.</p>
  <p hidden data-reason="${reason.replace(/"/g, "&quot;")}"></p>
</body>
</html>`;
  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function authUnavailableResponse(): Response {
  return Response.json(
    { error: "auth_sessions_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** 只读账户 / 非管理员的默认拒绝文案。 */
export const ADMIN_REQUIRED_MESSAGE = "只读账户，无写入权限";

/**
 * 管理接口统一鉴权：读会话 → 401 / 403 的收口。
 *
 * 这段 try/catch + 401 + 403 原先在 7 个 admin handler 里各抄了一份
 * （accounts、accounts/[id]、reveal、reorder、visitors、visitors/[hash]/ip、ray/[id]），
 * 收敛到这里，避免某处漏掉 no-store 或改了状态码而不自知。
 *
 * 返回 Response 表示拒绝（调用方直接 return），返回对象表示放行。
 * `forbiddenMessage` 给需要不同文案的调用方（如 blocklist 用「需要管理员权限」）。
 */
export async function requireAdminSession(
  env: Env,
  request: Request,
  forbiddenMessage: string = ADMIN_REQUIRED_MESSAGE,
): Promise<{ session: NonNullable<SessionData> } | Response> {
  let session: SessionData | null;
  try {
    session = await requireAuth(env, request);
  } catch {
    return authUnavailableResponse();
  }
  if (!session) {
    return Response.json({ error: "未登录" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (session.role !== "admin") {
    return Response.json(
      { error: forbiddenMessage },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return { session };
}

/** 会话「近期认证」的默认窗口（秒），来自 `config-contract.json`。 */
export const REVEAL_MAX_AUTH_AGE = REVEAL_MAX_AUTH_AGE_SECONDS;

/** 近期认证超时：前端据此跳 `/login?next=<当前页>` 重新走一次 Access 认证。 */
export const REAUTH_REQUIRED_MESSAGE = "需要重新验证";

/**
 * 步进式鉴权（step-up）：在 `requireAdminSession` 之上要求**近期认证**。
 *
 * 只有 Cloudflare Access 能签发 `authAt`（`functions/login.ts`），而会话 cookie
 * 本身有 30 天 TTL。明文密码查看属于最敏感的读操作，不能接受「30 天前登录过
 * 一次」就随时解密：本函数要求 `now - session.authAt <= maxAgeSeconds`
 * （默认 600 秒，见 `reveal_max_auth_age_seconds`），超时返回 401 +
 * `{ error: "需要重新验证", reauth: true }`，由前端跳 `/login` 重新认证。
 *
 * 判定顺序与 `requireAdminSession` 一致（鉴权 → 非 admin 403 → 近期认证 401），
 * 因此未登录仍是 401「未登录」、只读账户仍是 403；调用方拿到 Response 直接返回。
 *
 * 注意：重新认证是否**真的**要求用户再输一次凭据，取决于 Access 应用自身的
 * Session Duration；若 Access 会话仍然有效，`/login` 会静默签发新的 `authAt`。
 * 当前 `account.limooo.cn`（Limooo-Apple）的 Session Duration 已在 docs/21 记录。
 */
export async function requireRecentAdminSession(
  env: Env,
  request: Request,
  maxAgeSeconds: number = REVEAL_MAX_AUTH_AGE,
): Promise<{ session: SessionData } | Response> {
  const auth = await requireAdminSession(env, request);
  if (auth instanceof Response) return auth;
  const now = Math.floor(Date.now() / 1000);
  const age = now - auth.session.authAt;
  // 只判上界会让**未来**的 authAt 永远通过（age 为负）。今天不可利用——authAt 由
  // 签名 cookie 携带、只有 Access 能签发——但这是守护「明文密码查看」的唯一一道门，
  // 方向必须封闭（门禁 cookie 已有同样的 future 守卫）。
  if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds) {
    return Response.json(
      { error: REAUTH_REQUIRED_MESSAGE, reauth: true },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return { session: auth.session };
}
