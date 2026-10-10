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
 * `hmacSha256Hex` 的 CryptoKey 缓存（docs/22 遗留项）。
 *
 * 两件事必须被证明，不能只靠读代码：
 *
 * 1. **等价性**：缓存前后的签名逐字节相同。基准不用「本实现自己的旧版本」，
 *    而是 Node 内置 `createHmac` 这份独立实现——否则缓存把结果改坏了也可能
 *    自己跟自己一致。
 * 2. **收益**：`importKey` 的调用次数。用 spy 包住真的 `crypto.subtle.importKey`
 *    （保留真实语义），断言 N 次同 key 调用只 import 1 次、交替 key 各 1 次。
 *
 * 缓存是模块级状态，所以每个用例前 `resetHmacKeyCacheForTests()` 回到冷缓存，
 * 否则「第一次」会命中上一个用例留下的条目，计数就失去意义。
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hmacSha256Hex, resetHmacKeyCacheForTests, timingSafeEqual, toHex } from "./crypto";
import { mintGateCookie, readGateCookie } from "./gate";

/** 独立基准实现：Node 内置 HMAC-SHA256（与本模块无共享代码）。 */
function referenceHex(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/**
 * 用例内固定的输入向量：短 key、非 ASCII、互为前缀的 key。
 *
 * 这里**没有**空串 key：WebCrypto 本身拒绝零长度 HMAC 密钥（Node 与 Workers
 * 都报 `DataError: Zero-length key is not supported`），而生产调用点也都是
 * fail-closed 的——`GATE_HMAC_KEY` / `SESSION_HMAC_KEY` 为空时中间件直接 503，
 * 根本走不到 `hmacSha256Hex`。所以空串不是缓存必须支持的输入。
 */
const KEYS = {
  gate: "gate-hmac-secret-aaaaaaaaaaaaaaaa",
  session: "session-hmac-secret-bbbbbbbbbbbb",
  rotated: "session-hmac-secret-cccccccccccc",
  short: "k",
  prefix: "session-hmac-secret-bbbbbbbbbbbb-extra",
  unicode: "密钥-🔑-ключ",
} as const;

const DATASETS = {
  empty: "",
  ascii: "issued.expiry",
  json: JSON.stringify({ sub: "user-1", sid: "sid-1", exp: 1790000000 }),
  unicode: "中文-データ-🚀",
  long: "x".repeat(4096),
} as const;

/** 每个用例前的 importKey 调用计数（spy 装在真的 importKey 外面）。 */
let importKeyCalls = 0;
let importKeySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHmacKeyCacheForTests();
  importKeyCalls = 0;
  const real = crypto.subtle.importKey.bind(crypto.subtle);
  importKeySpy = vi
    .spyOn(crypto.subtle, "importKey")
    .mockImplementation((...args: Parameters<typeof real>) => {
      importKeyCalls += 1;
      return real(...args);
    });
});

afterEach(() => {
  importKeySpy.mockRestore();
  resetHmacKeyCacheForTests();
});

describe("hmacSha256Hex CryptoKey cache", () => {
  it("matches Node's own HMAC-SHA256 byte for byte across keys and payloads", async () => {
    for (const key of Object.values(KEYS)) {
      for (const data of Object.values(DATASETS)) {
        const actual = await hmacSha256Hex(key, data);
        expect(actual).toBe(referenceHex(key, data));
      }
    }
  });

  it("is stable across repeated and interleaved calls (no cache-induced drift)", async () => {
    // 第一次（冷缓存）的签名就是基准，之后同 key/不同 key 交替调用都必须相等。
    const baseline = new Map<string, string>();
    for (const key of Object.values(KEYS)) {
      baseline.set(key, await hmacSha256Hex(key, "issued.expiry"));
    }

    for (let round = 0; round < 5; round += 1) {
      for (const [name, key] of Object.entries(KEYS)) {
        // 交替：每个 key 之后都插一次别的 key，逼缓存来回换手。
        await hmacSha256Hex(KEYS.gate, `filler-${round}`);
        expect(await hmacSha256Hex(key, "issued.expiry")).toBe(baseline.get(key));
        expect(await hmacSha256Hex(key, "issued.expiry")).toBe(referenceHex(key, "issued.expiry"));
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it("imports the key once for 50 calls with the same key", async () => {
    const expected = referenceHex(KEYS.gate, "payload");
    for (let i = 0; i < 50; i += 1) {
      expect(await hmacSha256Hex(KEYS.gate, `payload-${i}`)).toBe(
        referenceHex(KEYS.gate, `payload-${i}`),
      );
    }
    expect(await hmacSha256Hex(KEYS.gate, "payload")).toBe(expected);
    expect(importKeyCalls).toBe(1);
  });

  it("imports one key each when two keys alternate", async () => {
    for (let i = 0; i < 20; i += 1) {
      await hmacSha256Hex(i % 2 === 0 ? KEYS.gate : KEYS.session, `p-${i}`);
    }
    expect(importKeyCalls).toBe(2);

    // 第三次换手不应再 import：两把都已在缓存里。
    await hmacSha256Hex(KEYS.gate, "again");
    await hmacSha256Hex(KEYS.session, "again");
    expect(importKeyCalls).toBe(2);
  });

  it("keeps keys that are prefixes of each other in separate cache slots", async () => {
    await hmacSha256Hex(KEYS.gate, "d");
    await hmacSha256Hex(KEYS.session, "d");
    await hmacSha256Hex(KEYS.prefix, "d");
    await hmacSha256Hex(KEYS.short, "d");
    await hmacSha256Hex(KEYS.unicode, "d");
    expect(importKeyCalls).toBe(5);

    // 互为前缀的两把 key，也必须分开缓存，不能串味。
    expect(await hmacSha256Hex(KEYS.prefix, "d")).toBe(referenceHex(KEYS.prefix, "d"));
    expect(await hmacSha256Hex(KEYS.short, "d")).toBe(referenceHex(KEYS.short, "d"));
    expect(await hmacSha256Hex(KEYS.session, "d")).toBe(referenceHex(KEYS.session, "d"));
    expect(importKeyCalls).toBe(5);
  });

  it("bounds the cache: the 9th distinct key evicts the least recently used one", async () => {
    // 上限 8 条：k0..k7 填满，k8 挤掉最久未用的 k0。
    for (let i = 0; i < 8; i += 1) {
      await hmacSha256Hex(`cache-key-${i}`, "d");
    }
    expect(importKeyCalls).toBe(8);

    await hmacSha256Hex("cache-key-8", "d");
    expect(importKeyCalls).toBe(9);

    // k0 已被淘汰 -> 再次调用必须重新 import（证明缓存确实有界）。
    await hmacSha256Hex("cache-key-0", "d");
    expect(importKeyCalls).toBe(10);

    // 而 k8 仍在缓存里 -> 不再 import。
    await hmacSha256Hex("cache-key-8", "d");
    expect(importKeyCalls).toBe(10);

    // 淘汰后重新 import 的 k0 签名仍与基准一致。
    expect(await hmacSha256Hex("cache-key-0", "d")).toBe(referenceHex("cache-key-0", "d"));
  });

  it("evicts the least recently used entry, not merely the oldest one", async () => {
    for (let i = 0; i < 8; i += 1) {
      await hmacSha256Hex(`lru-key-${i}`, "d");
    }
    // 触碰 k0 -> 它变成最新，被淘汰的应该是 k1。
    await hmacSha256Hex("lru-key-0", "d");
    expect(importKeyCalls).toBe(8);

    await hmacSha256Hex("lru-key-8", "d");
    expect(importKeyCalls).toBe(9);

    await hmacSha256Hex("lru-key-0", "d");
    expect(importKeyCalls).toBe(9); // 仍在
    await hmacSha256Hex("lru-key-1", "d");
    expect(importKeyCalls).toBe(10); // 已淘汰
  });

  it("keeps verifying signatures after a key rotation (old key still works, new key signs new)", async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const oldCookie = (await mintGateCookie(KEYS.session)).split(";")[0];
    const oldValue = oldCookie.slice(oldCookie.indexOf("=") + 1);
    const [issuedRaw, expiryRaw, oldSignature] = oldValue.split(".");

    // 轮换到新 key 后，旧 cookie 的签名仍是用**旧 key** 算出来的那串（逐字节不变）。
    expect(oldSignature).toBe(referenceHex(KEYS.session, `${issuedRaw}.${expiryRaw}`));

    const rotatedCookie = (await mintGateCookie(KEYS.rotated)).split(";")[0];
    const rotatedValue = rotatedCookie.slice(rotatedCookie.indexOf("=") + 1);
    const [, , newSignature] = rotatedValue.split(".");
    expect(newSignature).toBe(referenceHex(KEYS.rotated, `${issuedRaw}.${expiryRaw}`));
    expect(newSignature).not.toBe(oldSignature);
    expect(timingSafeEqual(oldSignature, newSignature)).toBe(false);

    // 旧 key 仍能验旧 cookie（rotation 不破坏已签发凭据的校验路径）。
    const oldState = await readGateCookie(oldValue, KEYS.session);
    expect(oldState.valid).toBe(true);
    expect(oldState.reason).toBe("ok");

    // 新 key 验旧 cookie 必须失败（否则等于接受已作废的密钥）。
    const mixed = await readGateCookie(oldValue, KEYS.rotated);
    expect(mixed.valid).toBe(false);
    expect(mixed.reason).toBe("bad_signature");

    // 轮换后再走一轮：新 key 已缓存、旧 key 仍命中，两者签名都不漂移。
    const callsBefore = importKeyCalls;
    await hmacSha256Hex(KEYS.session, `${issuedRaw}.${expiryRaw}`);
    await hmacSha256Hex(KEYS.rotated, `${issuedRaw}.${expiryRaw}`);
    expect(importKeyCalls).toBe(callsBefore);

    expect(issuedAt).toBeGreaterThan(0);
  });

  it("re-imports after an explicit cache reset (cold start parity)", async () => {
    const warm = await hmacSha256Hex(KEYS.gate, "d");
    expect(importKeyCalls).toBe(1);
    resetHmacKeyCacheForTests();
    expect(await hmacSha256Hex(KEYS.gate, "d")).toBe(warm);
    expect(importKeyCalls).toBe(2);
  });

  it("leaves toHex untouched by the cache", () => {
    // 顺带钉住 toHex：不在本轮改动范围，行为必须原样。
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });
});
