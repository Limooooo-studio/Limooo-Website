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

/** GET /api/ray/:id — 仅 admin 按 Ray ID 查询最小化请求记录 */

import { queryAll } from "../../_lib/d1";
import { requireAdminSession } from "../../_lib/session";
import type { Env } from "../../_lib/env";

interface RayRow {
  ray: string;
  ts: number;
  host: string;
  path: string;
  method: string;
  status: number;
  ip_hash: string;
  ua_family: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request }) => {
  const auth = await requireAdminSession(env, request, "无权限");
  if (auth instanceof Response) return auth;

  const id = String((params as { id?: string }).id ?? "").toLowerCase().split("-")[0];
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return Response.json({ ok: false, error: "invalid ray id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // 前缀匹配是**有意**的：落库的 `ray` 带 colo 后缀（`a48923a17e543777-LAX`，20 字符），
  // 而调用方给的是 16 位十六进制。用主键范围代替 `LIKE '<id>%'`：两者语义相同，
  // 但 `ray` 是 TEXT PRIMARY KEY，范围比较能走 `sqlite_autoindex_ray_log_v2_1`，
  // 而 `LIKE` 用不上主键索引、退化成按 `idx_ray_log_v2_ts` 全表扫（线上实测
  // `SCAN` → `SEARCH ... (ray>? AND ray<?)`）。上限用 `id` + U+10FFFF：它比任何
  // 可能的后缀都大，所以 `-LAX`、`-SIN` 乃至将来没有后缀或换别的后缀都能命中。
  const rows = await queryAll<RayRow>(
    env.DB,
    `SELECT ray, ts, host, normalized_path AS path, method, status, ip_hash, ua_family
     FROM ray_log_v2
     WHERE ray >= ? AND ray < ?
     ORDER BY ts DESC
     LIMIT 100`,
    id,
    `${id}\u{10ffff}`,
  );
  const safeRows = rows.map(({ ray, ts, host, path, method, status, ip_hash, ua_family }) => ({
    ray, ts, host, path, method, status, ip_hash, ua_family,
  }));
  return Response.json(
    { ok: true, count: safeRows.length, rows: safeRows },
    { headers: { "Cache-Control": "no-store" } },
  );
};
