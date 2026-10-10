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

describe("fernet", () => {
  it("decrypts the Python-generated fixture", async () => {
    const token = readFileSync(fixturePath, "utf8").trim();
    expect(await fernetDecrypt(token, TEST_KEY)).toBe("hello-limooo");
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
