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
