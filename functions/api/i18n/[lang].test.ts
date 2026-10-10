/**
 * GET /api/i18n/<lang> 语言字典接口（docs/22 W9-5）。
 *
 * 回归：`translations[lang]` 会沿原型链取到 `constructor` / `toString` /
 * `valueOf` / `__proto__` 这些成员，判定为「支持的语言」后 `JSON.stringify`
 * 一个函数得到 `undefined`，于是返回 `200` 空体（`__proto__` 是对象，
 * 直接吐 Object.prototype），还被 `max-age=86400` 缓存。
 */

import { describe, expect, it } from "vitest";
import { onRequestGet } from "./[lang]";
import { translations } from "../../_data/i18n";

function get(lang: string): Response {
  return onRequestGet({ params: { lang } }) as Response;
}

describe("api/i18n/[lang]", () => {
  it("serves a supported language", async () => {
    const resp = get("zh-cn");
    expect(resp.status).toBe(200);
    const dict = (await resp.json()) as Record<string, string>;
    expect(Object.keys(dict).length).toBeGreaterThan(0);
    expect(dict).toEqual(translations["zh-cn"]);
    expect(resp.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  it("404s an unknown language", () => {
    expect(get("xx-yy").status).toBe(404);
    expect(get("").status).toBe(404);
  });

  it("never resolves Object.prototype members as languages", async () => {
    // 这些都是 Object.prototype 上的成员，不是语言码。
    for (const lang of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "__defineGetter__",
    ]) {
      const resp = get(lang);
      expect(resp.status, `/${lang} must be 404`).toBe(404);
      const body = (await resp.json()) as { error?: string };
      expect(body.error, `/${lang} body`).toBe("unsupported language");
    }
  });

  it("only serves languages the contract actually declares", () => {
    // 反向断言：数据里有多少语言，接口就认多少；不多不少。
    for (const lang of Object.keys(translations)) {
      expect(get(lang).status, `/${lang}`).toBe(200);
    }
  });
});
