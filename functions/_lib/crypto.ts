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

/**
 * `importKey` 结果的缓存上限（条目数）。
 *
 * 取值依据：本仓库的 HMAC 密钥只有几把——`GATE_HMAC_KEY`、`SESSION_HMAC_KEY`
 * 以及调用方传入的 IP 哈希密钥，同时存活的**不同密钥串**是个位数；8 条足够
 * 覆盖「当前 + 刚轮换掉的旧值 + 测试里交替使用的几把」。上限本身不为正确性
 * 服务（见下），只为「密钥串不可控时内存不无限涨」兜底。
 */
const HMAC_KEY_CACHE_LIMIT = 8;

/**
 * HMAC 签名密钥缓存：key 字符串 -> 已 import 的 CryptoKey。
 *
 * **键就是完整的 key 字符串**，不做前缀/长度分槽：轮换密钥时新值是另一个
 * 字符串，自然缓存不命中并走一次 `importKey`；旧值的条目只是不再被访问，
 * 不需要显式失效（会话/门禁 cookie 的验签本来就会用「旧 key」再算一遍，
 * 所以旧条目在轮换后的过渡期还真的会被用到）。用前缀分槽反而会把两把不同
 * 的密钥挤进同一槽，拿错 CryptoKey 就会算出错误签名——签名热路径上不值得
 * 为省几字节冒这个险。
 *
 * 有界策略：`Map` 的插入序即 LRU 序，命中时先 `delete` 再 `set` 把它挪到末尾，
 * 超上限就删 `keys().next().value`（最久未使用的一条）。选 LRU 而不是「清空
 * 全部」，是因为轮换期会同时活跃新旧两把密钥，整体清空会让每一次新旧交替
 * 都退化成重新 import；而条目数上限只有 8，逐条淘汰的代价可以忽略。
 *
 * 进程/isolate 级缓存：每个 Worker isolate 一份，`importKey` 是可重入的纯
 * 操作，多 isolate 各自缓存一份等价且安全。失败（例如 key 无法导入）不会被
 * 缓存，异常照常抛出，下次调用会重新尝试。
 */
const hmacKeyCache = new Map<string, CryptoKey>();

/** 取出（必要时导入）HMAC-SHA256 签名密钥；同 key 复用同一个 CryptoKey。 */
async function hmacSigningKey(key: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(key);
  if (cached !== undefined) {
    // 命中即刷新 LRU 位置。
    hmacKeyCache.delete(key);
    hmacKeyCache.set(key, cached);
    return cached;
  }
  const imported = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacKeyCache.set(key, imported);
  while (hmacKeyCache.size > HMAC_KEY_CACHE_LIMIT) {
    const oldest = hmacKeyCache.keys().next();
    if (oldest.done) break;
    hmacKeyCache.delete(oldest.value);
  }
  return imported;
}

/** HMAC-SHA256 -> 十六进制串（密钥用途由调用方决定，本函数不做域分隔）。 */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await hmacSigningKey(key);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data)));
  return toHex(sig);
}

/** 仅供测试：清空密钥缓存，让每个用例从冷缓存开始。 */
export function resetHmacKeyCacheForTests(): void {
  hmacKeyCache.clear();
}

/** 常量时间字符串比较，避免签名校验泄漏时序信息。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
