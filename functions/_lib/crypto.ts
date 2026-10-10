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
 * Pages Functions 侧共用的密码学/编码原语。
 *
 * 这些实现原先在 csrf.ts / gate.ts / logging.ts / session.ts 里各抄了一份
 * （toHex ×4、hmacSha256Hex ×4、timingSafeEqual ×3、toB64Url ×2），
 * 安全相关的常量时间比较与 HMAC 尤其不该有多份走样实现，故收敛到这里。
 *
 * 只放**无语义**的通用原语；带业务含义的逻辑（如 verifyPayload 的 token 结构
 * 校验）仍留在各自模块里。
 */

const textEncoder = new TextEncoder();

/** 字节数组 -> 小写十六进制串。 */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 字节数组 -> 无填充的 base64url（Cookie/JWT 风格，可安全放进 cookie 值）。 */
export function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 无填充 base64url -> 字节数组。 */
export function fromB64Url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HMAC-SHA256 -> 十六进制串（密钥用途由调用方决定，本函数不做域分隔）。 */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data)));
  return toHex(sig);
}

/** 常量时间字符串比较，避免签名校验泄漏时序信息。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
