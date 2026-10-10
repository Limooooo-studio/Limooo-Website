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
 * detectLang 的兜底值必须来自契约（DEFAULT_LANG），不能是写死的语言码。
 *
 * 这里把 `config` 里的 DEFAULT_LANG 换成另一门受支持语言再断言：
 * 如果 detectLang 里还留着 `"en-us"` 这类字面量，本文件必然变红。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, DEFAULT_LANG: "ja-jp" };
});

import { DEFAULT_LANG, SUPPORTED_LANGS } from "./config";
import { detectLang } from "./routing";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://limooo.cn/", { headers: { Host: "limooo.cn", ...headers } });
}

describe("detectLang fallback follows the contract DEFAULT_LANG", () => {
  it("uses the contract value, not a hardcoded language code", () => {
    expect(DEFAULT_LANG).toBe("ja-jp");
    expect(SUPPORTED_LANGS).toContain("ja-jp");
    expect(detectLang(req())).toBe("ja-jp");
  });

  it("still prefers the cookie and Accept-Language over the fallback", () => {
    expect(detectLang(req({ Cookie: "user_lang_preference=ko-kr" }))).toBe("ko-kr");
    expect(detectLang(req({ "Accept-Language": "zh-CN,zh;q=0.9" }))).toBe("zh-cn");
  });
});
