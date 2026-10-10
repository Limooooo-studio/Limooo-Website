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
 * 结构化单行 JSON 运行日志（与 ops/sync-worker/src/index.ts 的 logRun 同形）。
 *
 * 为什么抽成模块：d1-archive 现在有**两个** job（d1_archive / config_backup），
 * 各自都要「成功 console.log、失败 console.error」这条约定；复制两份必然漂移，
 * 而漂移的表现是「失败不再进 error 流」，也就是失败可见性悄悄失效。
 *
 * outcome==='failed' 走 console.error，因此 `wrangler tail` 与 Workers 日志面板
 * 可以按 `"outcome":"failed"` 检索。
 */
import { runStartedAt } from "../../sync-worker/src/runlog";

export function logRun(job: string, fields: Record<string, unknown> & { outcome?: string }): void {
  const payload: { event: string; ts: number; job: string; outcome?: string } & Record<
    string,
    unknown
  > = { event: job, ts: runStartedAt(), job, ...fields };
  const line = JSON.stringify(payload);
  if (payload.outcome === "failed") console.error(line);
  else console.log(line);
}
