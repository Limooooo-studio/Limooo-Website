// 由 build.py 自动生成，勿手改。
import { translations } from "../../_data/i18n";

export const onRequestGet = ({ params }: { params: Record<string, string> }) => {
  const lang = String((params as { lang?: string }).lang ?? "");
  // 必须用 hasOwnProperty 判定：translations 是普通对象字面量，
  // 直接 translations[lang] 会沿原型链取到 constructor / toString /
  // valueOf / __proto__ 等成员，被判成「支持的语言」后 JSON.stringify
  // 一个函数得到 undefined → 200 空体，还被 max-age=86400 缓存。
  if (!Object.prototype.hasOwnProperty.call(translations, lang)) {
    return new Response(JSON.stringify({ error: "unsupported language" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const dict = translations[lang];
  return new Response(JSON.stringify(dict), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
};
