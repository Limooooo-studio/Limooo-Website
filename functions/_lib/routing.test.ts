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

/** 语言 cookie 的全站共享行为（Domain=.limooo.cn，主域与所有子域一致）。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXEMPT_PATH_PREFIXES,
  detectLang,
  isExemptPath,
  langCookieHeader,
  requestUrl,
  withLangCookie,
} from "./routing";
import { DEFAULT_LANG, LANG_COOKIE, SUPPORTED_LANGS } from "./config";

function req(host: string, cookie?: string, accept?: string): Request {
  const headers: Record<string, string> = { Host: host };
  if (cookie) headers.Cookie = cookie;
  if (accept) headers["Accept-Language"] = accept;
  return new Request(`https://${host}/`, { headers });
}

describe("detectLang reads the shared language cookie", () => {
  it("main domain reads the cookie", () => {
    expect(detectLang(req("limooo.cn", "user_lang_preference=ja-jp", "en-US"))).toBe("ja-jp");
  });

  it("all *.limooo.cn subdomains share one cookie (visitor / account / status / images)", () => {
    for (const host of [
      "visitor.limooo.cn",
      "account.limooo.cn",
      "status.limooo.cn",
      "images.limooo.cn",
      "auth.limooo.cn",
      "services.limooo.cn",
      "some-future-sub.limooo.cn",
    ]) {
      expect(detectLang(req(host, "user_lang_preference=ko-kr", "en-US")), host).toBe("ko-kr");
    }
  });

  it("cookie is case-insensitive; invalid values fall back to Accept-Language", () => {
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=ZH-CN"))).toBe("zh-cn");
    expect(detectLang(req("visitor.limooo.cn", "user_lang_preference=xx-yy", "ja-JP"))).toBe("ja-jp");
  });

  it("foreign domains do not read the cookie", () => {
    expect(detectLang(req("evil.example.com", "user_lang_preference=ko-kr", "en-US"))).toBe("en-us");
  });

  it("falls back to Accept-Language when no cookie is present", () => {
    expect(detectLang(req("visitor.limooo.cn", undefined, "ko-KR,ko;q=0.9"))).toBe("ko-kr");
  });

  it("derives region prefixes from the language codes (zh-Hant -> zh-cn, en-GB -> en-us)", () => {
    expect(detectLang(req("limooo.cn", undefined, "zh-Hant,zh;q=0.9"))).toBe("zh-cn");
    expect(detectLang(req("limooo.cn", undefined, "en-GB,en;q=0.8"))).toBe("en-us");
  });

  it("falls back to the contract DEFAULT_LANG when nothing matches", () => {
    expect(SUPPORTED_LANGS).toContain(DEFAULT_LANG);
    expect(detectLang(req("limooo.cn"))).toBe(DEFAULT_LANG);
    expect(detectLang(req("limooo.cn", undefined, "de-DE,de;q=0.9"))).toBe(DEFAULT_LANG);
  });

  it("maps the CF country to a language via its region subtag (CN -> zh-cn)", () => {
    const withCountry = (country: string): Request =>
      Object.assign(new Request("https://limooo.cn/", { headers: { Host: "limooo.cn" } }), {
        cf: { country },
      });
    expect(detectLang(withCountry("CN"))).toBe("zh-cn");
    expect(detectLang(withCountry("JP"))).toBe("ja-jp");
    expect(detectLang(withCountry("KR"))).toBe("ko-kr");
    expect(detectLang(withCountry("DE"))).toBe(DEFAULT_LANG);
  });
});

describe("detectLang is contract-driven (no language codes in the source)", () => {
  it("contains no hardcoded supported language literal", () => {
    const source = readFileSync(fileURLToPath(new URL("./routing.ts", import.meta.url)), "utf8");
    for (const lang of SUPPORTED_LANGS) {
      expect(source, `routing.ts must not hardcode ${lang}`).not.toContain(`"${lang}"`);
      expect(source, `routing.ts must not hardcode ${lang}`).not.toContain(`'${lang}'`);
    }
  });
});

describe("exempt paths match exactly or as a subpath", () => {
  it("exempts the exact path and its children", () => {
    for (const prefix of EXEMPT_PATH_PREFIXES) {
      expect(isExemptPath(prefix), prefix).toBe(true);
      expect(isExemptPath(`${prefix}/child`), prefix).toBe(true);
    }
  });

  it("does not exempt lookalike prefixes such as /account-x", () => {
    expect(isExemptPath("/account-anything")).toBe(false);
    expect(isExemptPath("/login-as-admin")).toBe(false);
    expect(isExemptPath("/visitors")).toBe(false);
    expect(isExemptPath("/api/apple-accountant")).toBe(false);
    expect(isExemptPath("/api/raytrace")).toBe(false);
  });
});

describe("langCookieHeader domain scope", () => {
  it("both main domain and subdomains set Domain=.limooo.cn", () => {
    for (const host of ["limooo.cn", "visitor.limooo.cn", "images.limooo.cn"]) {
      expect(langCookieHeader(host, "ja-jp"), host).toContain("Domain=.limooo.cn");
    }
  });

  it("Host with a port is handled correctly (local preview)", () => {
    expect(langCookieHeader("limooo.cn:8788", "ja-jp")).toContain("Domain=.limooo.cn");
  });

  it("foreign domains get no Domain attribute", () => {
    expect(langCookieHeader("evil.example.com", "ja-jp")).not.toContain("Domain=");
  });

  it("cookie attributes are complete (Path / Max-Age / SameSite / Secure)", () => {
    const header = langCookieHeader("limooo.cn", "zh-cn");
    expect(header).toContain("user_lang_preference=zh-cn");
    expect(header).toContain("Path=/");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});

/** docs/22 增量 ②：URL 每请求只解析一次，语言检测结果沿调用链复用。 */
describe("request URL parsing and language reuse", () => {
  it("parses the request URL once per Request object", () => {
    const request = new Request("https://limooo.cn/services?challenge=1");
    const first = requestUrl(request);
    expect(requestUrl(request)).toBe(first);
    expect(first.searchParams.get("challenge")).toBe("1");
  });

  it("withLangCookie uses the language it is given and falls back to detection", () => {
    const request = new Request("https://limooo.cn/");
    const explicit = withLangCookie(request, new Response("body"), "ko-kr");
    expect(explicit.headers.get("Set-Cookie")).toContain(`${LANG_COOKIE}=ko-kr`);

    // 不传 lang 时保持旧行为：自己检测（这里由 Accept-Language 决定）。
    const detected = withLangCookie(
      new Request("https://limooo.cn/", { headers: { "Accept-Language": "ja-JP" } }),
      new Response("body"),
    );
    expect(detected.headers.get("Set-Cookie")).toContain(`${LANG_COOKIE}=ja-jp`);
  });

  it("does not touch the cookie when the visitor already has one", () => {
    const request = new Request("https://limooo.cn/", {
      headers: { Cookie: `${LANG_COOKIE}=zh-cn` },
    });
    const resp = withLangCookie(request, new Response("body"), "ko-kr");
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });
});
