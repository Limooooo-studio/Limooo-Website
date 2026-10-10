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

/** Fernet 双向互通测试：Python 固化的 token 与 WebCrypto 实现互相解密。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fernetDecrypt, fernetEncrypt } from "./fernet";

const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const fixturePath = fileURLToPath(new URL("../../tests/fixtures/fernet_token.txt", import.meta.url));
const tsFixturePath = fileURLToPath(
  new URL("../../tests/fixtures/fernet_token_ts.txt", import.meta.url),
);

describe("fernet", () => {
  it("decrypts the Python-generated fixture", async () => {
    const token = readFileSync(fixturePath, "utf8").trim();
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("hello-limooo");
  });

  /**
   * W5-3：`fernetEncrypt` 的 base64url **必须保留 `=` 填充**。
   *
   * 生产真正依赖的方向是「TS 加密 → Python 解密」：`tracking.ts` 写 `ip_enc`，
   * `ops/check_ip_rays.py` 用 `cryptography.fernet.Fernet.decrypt()` 解（内部是
   * `base64.urlsafe_b64decode`，缺填充直接抛 `InvalidToken`）。
   * 谁把这里的 `base64UrlEncode` 「简化」成共用的 `crypto.ts` 的 `toB64Url`
   * （会去掉填充），整条链路就会对所有 IP 报「无记录」，而当时没有任何用例会红。
   * 长度 100（73 字节）是确定值：AES-CBC 密文恒为 16 的倍数，所以这个输入必然带 `==`。
   */
  it("keeps the base64 padding that Python's Fernet decoder requires", async () => {
    const token = await fernetEncrypt("8.8.8.8", TEST_KEY);
    expect(token).toContain("=");
    expect(token.length % 4).toBe(0);
  });

  it("decrypts the TS-generated fixture (the TS -> Python sample)", async () => {
    const token = readFileSync(tsFixturePath, "utf8").trim();
    expect(token).toContain("=");
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("8.8.8.8");
  });

  it("encrypts and decrypts round-trip", async () => {
    const token = await fernetEncrypt("hello-limooo", TEST_KEY);
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("hello-limooo");
  });

  it("rejects a wrong key", async () => {
    const token = await fernetEncrypt("hello-limooo", TEST_KEY);
    await expect(fernetDecrypt(token, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWZ9")).rejects.toThrow();
  });
});
