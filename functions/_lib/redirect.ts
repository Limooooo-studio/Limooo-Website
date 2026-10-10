/** 统一跳转页（redirect.<root_domain>）：纯中转，不经过人机验证。 */

import { detectLang, escapeHtml, withLangCookie } from "./routing";
import type { RequestContext } from "./routing";
import { BASE_URL, REDIRECT_HOSTNAME } from "./config";
import { REDIRECT_I18N, REDIRECT_PRELOAD_IMAGES } from "../_data/runtime";

/** 读取生成好的 <lang>/redirect.html，注入 to / preload / preload_links。 */
export async function renderRedirectPage(context: RequestContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  let to = url.searchParams.get("to") ?? "";
  if (!/^https:\/\//.test(to)) to = `${BASE_URL}/`;
  const lang = detectLang(request);
  const preload = to.startsWith(`${BASE_URL}/`);
  const rels = preload ? REDIRECT_PRELOAD_IMAGES : [];
  const preloadLinks = rels
    .map((rel) => `<link rel="preload" as="image" href="${escapeHtml(rel)}">`)
    .join("\n    ");

  if (!env.ASSETS) return new Response("Redirect page unavailable", { status: 503 });
  const asset = await env.ASSETS.fetch(new URL(`/${lang}/redirect.html`, BASE_URL));
  if (!asset.ok) return new Response("Redirect page unavailable", { status: 503 });
  // 语言由模板的 <html lang="{{ g.lang }}"> 在构建期渲染；`{{lang}}` 占位符
  // 已不存在于任何模板或产物中（grep 零命中），这里只注入运行时的 to/preload。
  const html = (await asset.text())
    .replaceAll("{{to}}", escapeHtml(to))
    .replaceAll("{{preload}}", JSON.stringify(rels))
    .replaceAll("{{preload_links}}", preloadLinks);

  return withLangCookie(
    request,
    new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}

/** 跳转子域判断，供中间件编排使用。 */
export function isRedirectHost(hostname: string): boolean {
  return hostname === REDIRECT_HOSTNAME;
}
