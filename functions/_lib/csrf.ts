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

/** 敏感 API 的同步双提交 CSRF 保护。
 *
 * 真正拦下跨站写请求的是两条，缺一不可：
 * 1. **Origin 校验**：只接受 `PROD_ORIGINS` 里的本村子域（`visitor.` /
 *    `account.`），且**生产环境默认不放行 localhost**；跨站表单/脚本拿不到
 *    合法 Origin 头。
 * 2. **双提交 + 自定义头**：cookie（非 HttpOnly，前端要读）与
 *    `X-CSRF-Token` 头必须完全一致。跨站请求既读不到 cookie，也无法在
 *    普通表单提交时附带自定义头。
 *
 * 在此基础上 token 还要**绑定会话**：签名覆盖 `csrf:<sid>:<payload>`，
 * 于是 A 会话签出的 token 在 B 会话里验不过（同站其它子域即使能种 cookie 也
 * 不能拿旧 token 顶用）。`sid` 由调用方从已校验的会话传入
 * （`/api/auth/status` 签发、各写接口校验）；未登录场景当前没有签发点，
 * 因此不设空 `sid` 特例。
 *
 * localhost 放行只用于本地 `wrangler pages dev`：设 `ALLOW_LOCAL_ORIGINS=1`
 * （写进本地 `.dev.vars`）才生效，生产不设即默认关闭。
 */

import {
  APPLE_ACCOUNT_HOSTNAME,
  CSRF_COOKIE,
  VISITOR_HOSTNAME,
} from "./config";
import type { Env } from "./env";
import { getCookie } from "./routing";
import { hmacSha256Hex, timingSafeEqual, toB64Url } from "./crypto";

export const CSRF_HEADER_NAME = "X-CSRF-Token";
export const CSRF_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const PROD_ORIGINS = new Set([
  `https://${VISITOR_HOSTNAME}`,
  `https://${APPLE_ACCOUNT_HOSTNAME}`,
]);
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;

/** 显式开关：只有值为 `1` 时才放行 localhost Origin（本地开发用）。 */
function localOriginsAllowed(env: Env): boolean {
  return (env.ALLOW_LOCAL_ORIGINS ?? "").trim() === "1";
}

function csrfSecret(env: Env): string {
  return env.SESSION_HMAC_KEY || env.GATE_HMAC_KEY || "";
}

/** 签名载荷：token 与会话绑定，换一个 `sid` 即失效。 */
function csrfPayload(sid: string, payload: string): string {
  return `csrf:${sid}:${payload}`;
}

async function validToken(token: string, sid: string, secret: string): Promise<boolean> {
  if (!secret || !token || !sid) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(signature, await hmacSha256Hex(secret, csrfPayload(sid, payload)));
}

function isAllowedOrigin(env: Env, origin: string): boolean {
  const normalized = origin.replace(/\/+$/, "");
  if (PROD_ORIGINS.has(normalized)) return true;
  return localOriginsAllowed(env) && LOCAL_ORIGIN_RE.test(normalized);
}

/**
 * 签发一次绑定 `sid` 的 CSRF token；cookie 不能设为 HttpOnly，前端需要读取后
 * 放到请求头。`sid` 必填——调用方必须已经通过会话校验。
 */
export async function createCsrfToken(env: Env, sid: string): Promise<{ token: string }> {
  const secret = csrfSecret(env);
  if (!secret) throw new Error("CSRF secret is not configured");
  if (!sid) throw new Error("CSRF session id is required");
  const payload = toB64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token: `${payload}.${await hmacSha256Hex(secret, csrfPayload(sid, payload))}` };
}

export function csrfCookieHeader(token: string, secure = true): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${CSRF_COOKIE_MAX_AGE}; SameSite=Lax; ${secure ? "Secure; " : ""}`;
}

/**
 * 校验写请求：Origin 可信 + cookie/header 双提交一致 + 服务端签名有效且绑定
 * 到当前 `sid`。`sid` 取自调用方已经校验过的会话。
 */
export async function verifyCsrf(env: Env, request: Request, sid: string): Promise<boolean> {
  const origin = request.headers.get("Origin") ?? "";
  if (!isAllowedOrigin(env, origin)) return false;
  const header = request.headers.get(CSRF_HEADER_NAME) ?? "";
  const cookie = getCookie(CSRF_COOKIE, request.headers.get("Cookie")) ?? "";
  if (!header || !cookie || header !== cookie) return false;
  return validToken(header, sid, csrfSecret(env));
}
