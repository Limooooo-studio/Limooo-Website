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
  const rows = await queryAll<RayRow>(
    env.DB,
    `SELECT ray, ts, host, normalized_path AS path, method, status, ip_hash, ua_family
     FROM ray_log_v2
     WHERE ray LIKE ?
     ORDER BY ts DESC
     LIMIT 100`,
    `${id}%`,
  );
  const safeRows = rows.map(({ ray, ts, host, path, method, status, ip_hash, ua_family }) => ({
    ray, ts, host, path, method, status, ip_hash, ua_family,
  }));
  return Response.json(
    { ok: true, count: safeRows.length, rows: safeRows },
    { headers: { "Cache-Control": "no-store" } },
  );
};
