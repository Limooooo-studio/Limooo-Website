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
