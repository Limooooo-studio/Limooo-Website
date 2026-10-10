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
 * 统一跳转页 `renderRedirectPage` 测试（docs/22 W5-11）。
 *
 * 零测试的这段代码把**请求方可控**的 `?to=` 注入生成好的 HTML：`escapeHtml`
 * 是唯一的防线，而没有任何用例锁住它。这里用真实实现（路由 / 语言 cookie /
 * 转义）跑，只把 `env.ASSETS` 换成固定 HTML。`{{lang}}` 占位符已随 W1-4 从
 * 模板与产物中移除（语言在构建期由 `<html lang="{{ g.lang }}">` 渲染），
 * 因此这里只断言运行时注入的三个占位符。
 */

import { describe, expect, it, vi } from "vitest";
import { isRedirectHost, renderRedirectPage } from "./redirect";
import { BASE_URL, LANG_COOKIE, REDIRECT_HOSTNAME } from "./config";
import type { Env } from "./env";

const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en-us">',
  "<head>",
  '  <link rel="preload" as="image" href="{{preload_links}}">',
  '  <script id="redirect-data" type="application/json">{"to":"{{to}}","preload":{{preload}}}</script>',
  "</head>",
  "<body></body>",
  "</html>",
].join("\n");

function assets(html = TEMPLATE, ok = true) {
  const fetch = vi.fn(async () => new Response(html, { status: ok ? 200 : 404 }));
  return { fetch } as unknown as Env["ASSETS"];
}

function context(url: string, env: Env) {
  return {
    request: new Request(url),
    env,
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

async function render(url: string, env: Env) {
  const resp = await renderRedirectPage(context(url, env) as never);
  return { resp, html: await resp.text() };
}

describe("renderRedirectPage", () => {
  it("injects an escaped to and leaves no placeholder behind", async () => {
    const payload = 'https://evil.example.com/"><script>alert(1)</script>';
    const { resp, html } = await render(
      `https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(payload)}`,
      { ASSETS: assets() } as Env,
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    // 仍在 https 允许范围内，因此原样保留（只做转义，不改写）。
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    // 引号必须被转义，否则能把 data 属性的 JSON 提前闭合。
    expect(html).not.toContain('https://evil.example.com/">');
    expect(html).not.toContain('{"to":"https://evil.example.com/"');
    // 三个占位符都必须被替换掉。
    expect(html).not.toContain("{{");
  });

  it("falls back to the main site for anything that is not an https URL", async () => {
    for (const raw of [
      "",
      "http://limooo.cn/",
      "javascript:alert(1)",
      "//evil.example.com/",
      "/portfolio",
    ]) {
      const url = `https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(raw)}`;
      const { html } = await render(url, { ASSETS: assets() } as Env);
      expect(html).toContain(`"to":"${BASE_URL}/"`);
    }
  });

  it("only preloads portfolio images when the target stays on the main site", async () => {
    const internal = await render(`https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(`${BASE_URL}/portfolio`)}`, {
      ASSETS: assets(),
    } as Env);
    expect(internal.html).toContain('<link rel="preload" as="image" href="https://images.limooo.cn/');
    expect(internal.html).not.toContain('"preload":[]');

    const external = await render(`https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent("https://example.com/x")}`, {
      ASSETS: assets(),
    } as Env);
    expect(external.html).not.toContain('<link rel="preload" as="image" href="https://images.limooo.cn/');
    expect(external.html).toContain('"preload":[]');
  });

  it("writes the language cookie on first visit and stays quiet afterwards", async () => {
    const url = `https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(`${BASE_URL}/`)}`;

    const first = await render(url, { ASSETS: assets() } as Env);
    expect(first.resp.headers.getSetCookie()).toHaveLength(1);
    expect(first.resp.headers.get("Set-Cookie")).toContain(`${LANG_COOKIE}=`);

    // 已经有语言 cookie：不再重复下发，并且按 cookie 的语言取页面。
    const router = assets();
    const withCookie = await renderRedirectPage({
      request: new Request(url, { headers: { Cookie: `${LANG_COOKIE}=ko-kr` } }),
      env: { ASSETS: router } as Env,
      next: async () => new Response("next"),
      waitUntil: vi.fn(),
    } as never);
    expect(withCookie.headers.getSetCookie()).toHaveLength(0);
    expect(String(vi.mocked(router.fetch).mock.calls[0][0])).toBe(
      `${BASE_URL}/ko-kr/redirect.html`,
    );
  });

  it("fetches the generated page for the detected language", async () => {
    const router = assets();
    await render(`https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(`${BASE_URL}/`)}`, {
      ASSETS: router,
    } as Env);
    const requested = String(vi.mocked(router.fetch).mock.calls[0][0]);
    expect(requested).toBe(`${BASE_URL}/en-us/redirect.html`);
  });

  it("503s instead of rendering a half-injected page", async () => {
    const missing = await render(`https://${REDIRECT_HOSTNAME}/`, {} as Env);
    expect(missing.resp.status).toBe(503);
    expect(missing.html).not.toContain("{{");

    const broken = await render(`https://${REDIRECT_HOSTNAME}/`, {
      ASSETS: assets(TEMPLATE, false),
    } as Env);
    expect(broken.resp.status).toBe(503);
  });
});

describe("isRedirectHost", () => {
  it("only claims the redirect hostname", () => {
    expect(isRedirectHost(REDIRECT_HOSTNAME)).toBe(true);
    expect(isRedirectHost("limooo.cn")).toBe(false);
    expect(isRedirectHost(`evil.${REDIRECT_HOSTNAME}`)).toBe(false);
  });
});

/**
 * 模板文本缓存（docs/22 增量 ③）：同一语言的模板只从 ASSETS 取一次，
 * 注入仍然逐请求执行；不同语言各取各的；取回失败不缓存。
 */
describe("renderRedirectPage template cache", () => {
  it("fetches the template once for repeated renders of the same language", async () => {
    const router = assets();
    const url = `https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(`${BASE_URL}/portfolio`)}`;
    const first = await render(url, { ASSETS: router } as Env);
    const second = await render(url, { ASSETS: router } as Env);

    expect(vi.mocked(router.fetch)).toHaveBeenCalledTimes(1);
    expect(first.html).toBe(second.html);
    expect(first.html).toContain('<link rel="preload" as="image" href="https://images.limooo.cn/');
    expect(first.html).not.toContain("{{");
  });

  it("keeps one template per language", async () => {
    const router = assets();
    const url = `https://${REDIRECT_HOSTNAME}/?to=${encodeURIComponent(`${BASE_URL}/`)}`;
    await render(url, { ASSETS: router } as Env);
    await renderRedirectPage({
      request: new Request(url, { headers: { Cookie: `${LANG_COOKIE}=ko-kr` } }),
      env: { ASSETS: router } as Env,
      next: async () => new Response("next"),
      waitUntil: vi.fn(),
    } as never);

    expect(vi.mocked(router.fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      `${BASE_URL}/en-us/redirect.html`,
      `${BASE_URL}/ko-kr/redirect.html`,
    ]);
  });

  it("does not cache a failed template fetch", async () => {
    const router = assets(TEMPLATE, false);
    expect((await render(`https://${REDIRECT_HOSTNAME}/`, { ASSETS: router } as Env)).resp.status).toBe(503);
    expect((await render(`https://${REDIRECT_HOSTNAME}/`, { ASSETS: router } as Env)).resp.status).toBe(503);
    expect(vi.mocked(router.fetch)).toHaveBeenCalledTimes(2);
  });
});
