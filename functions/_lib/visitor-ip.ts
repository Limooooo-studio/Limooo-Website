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
 * 访客行 IP 的加密/解密（Fernet，独立密钥 `VISITOR_IP_KEY`）。
 *
 * 为什么不是哈希：`ip_hash` 单向，无法还原，运维上「这个访客是谁」就永远答不出来。
 * 这里改成加密存储 —— 列表接口仍然只发 `ip_hash`，只有 admin 点击某一行时，
 * `/api/visitors/<hash>/ip` 才在 Worker 内解密这一条并返回。
 *
 * 密钥不复用 `OBSERVABILITY_HMAC_KEY` / `APPLE_ACCOUNT_ENCRYPTION_KEY`：
 * 前者是哈希密钥、后者保护 Apple Account 口令，用途分离（同 GATE_HMAC_KEY
 * 与 OBSERVABILITY_HMAC_KEY 的拆分约定）。
 *
 * 失败语义：写侧 fail-open（密钥缺失或加密失败只记空串，绝不阻塞访客埋点）；
 * 读侧 fail-closed（拿不到明文就返回 null，由调用方回 404/503）。
 */

import { fernetDecrypt, fernetEncrypt } from "./fernet";
import type { Env } from "./env";

/** 密钥（未配置时为空串）。 */
export function visitorIpKey(env: Env): string {
  return (env.VISITOR_IP_KEY ?? "").trim();
}

/** 加密访客 IP；未配置密钥或 IP 为空时返回空串。 */
export async function encryptVisitorIp(ip: string, env: Env): Promise<string> {
  const key = visitorIpKey(env);
  if (!ip || !key) return "";
  try {
    return await fernetEncrypt(ip, key);
  } catch {
    // 埋点不能因为加密失败而报错或丢掉整行统计。
    return "";
  }
}

/** 解密访客 IP；密钥缺失、密文为空或校验失败时返回 null。 */
export async function decryptVisitorIp(token: string, env: Env): Promise<string | null> {
  const key = visitorIpKey(env);
  if (!token || !key) return null;
  try {
    const ip = await fernetDecrypt(token, key);
    return ip || null;
  } catch {
    return null;
  }
}
