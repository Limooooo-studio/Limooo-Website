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
 * 行数据的 JSONL + gzip 序列化：分析归档（analytics/）与配置快照（backup/）共用。
 *
 * 为什么单独一个模块：两条写入路径的**字节级格式必须一致**（每行一个 JSON 对象、
 * 行尾 \n、gzip），否则还原脚本要按前缀分两套解析。实现只此一份。
 *
 * 类型保真（灾备快照的硬要求）：JSON 天然区分 `0` / `1` / `"0"` / `""` / `null`，
 * 所以 active=0/1、epoch 整数、NULL 与空串都能原样回来；**不要**在这里做任何
 * 字符串化或默认值填充，那正是丢类型的开始。
 */
export async function gzipJsonl(rows: unknown[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const source = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const stream = new Blob([encoder.encode(source)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
