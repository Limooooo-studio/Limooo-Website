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
 * 封禁链路的关键不变量：**Cloudflare IP List 的条目集合 == D1 `blocked_ips`
 * 里 `active = 1` 的 CIDR 集合**（docs/22；AGENTS.md「封禁链路约定」）。
 *
 * 这条不变量此前只有 `ops/check_blocklist_sync.py` 一个读者，而它是纯手工入口
 * （实测被自动化调用 0 处）。于是「同步部分失败」或「有人在 Dashboard 手改了
 * List」都只能在下次有人想起来跑脚本时才被发现——D1 侧看一切正常，边缘已经
 * 不封了。本文件把这条检查搬进 status-worker 的每日任务（cron `47 3 * * *`），
 * 异常交给现有告警通道；手工排查仍然用那个 py 脚本（它还能做 `--record` 与
 * 更详细的分页输出），两者结论口径一致：都只比对这两个集合。
 *
 * 为什么在 status-worker 里**自带一份最小实现**，而不是 import
 * `ops/sync-worker/src/runlog.ts` 那种跨 Worker 依赖：status-worker 与
 * sync-worker 是两个独立部署单元，这里的职责只是「只读比对」，不是同步。
 * 跨目录 import 会把整个 sync-worker 拖进 status-worker 的打包图，为一个只读
 * 检查引入结构性耦合不值得（`ops/d1-archive` 依赖 `sync-worker/src/runlog.ts`
 * 是「共用同一套写入约定」的合理场景，检查不是）。代价是 `LIST_NAME`、
 * API 路径与 `normalizeListItem` 的规则在这一份里重复了一遍，因此两处都留了
 * 指向对方的注释：改 `ops/sync-worker/src/index.ts` 的归一化/路径时，这里要跟着改
 * （反之亦然），`blockslist.test.ts` 钉住了这里的语义。
 *
 * 成本纪律（AGENTS.md「D1 读取预算」）：
 *   - 每天只跑一次，只在每日任务里。
 *   - D1 侧只有一条 `SELECT cidr FROM blocked_ips WHERE active = 1`（走
 *     `idx_blocked_ips_active`，线上实测 `rows_read=1`）。
 *   - Cloudflare 侧两次只读 API：按名字找 List（拿 id）+ 读一页 items
 *     （`per_page=500`，线上实测 1 条、无 cursor）。列表 id 不写死在代码里——
 *     它是不透明的，重建 List 后会变，写死等于埋一个静默失效。
 *   - 凭据缺失 / D1 读失败 / API 失败一律 fail-open：只记日志、不报警，
 *     这样别人 clone 之后没配 secret 也不会收到误报。
 */

/** 与 ops/sync-worker/src/index.ts 的 LIST_NAME 同源（各一份，见文件头注释）。 */
export const LIST_NAME = "limooo_blocklist";
/** 与 ops/sync-worker/src/index.ts 同源：Cloudflare API 基址。 */
export const CF_API = "https://api.cloudflare.com/client/v4";
/** items 接口 per_page 上限 500；传 1000 会 400。 */
export const PAGE_SIZE = 500;
/** cursor 翻页没有「最后一页」标志，给迭代上限防止上游行为变化时死循环。 */
export const MAX_ITEM_PAGES = 20;

/**
 * 与 ops/sync-worker/src/index.ts 的 normalizeListItem 同源（**改一处必须改两处**）。
 *
 * Cloudflare 会把 IPv4 /32 归一化成裸 IP（写 1.2.3.4/32、读回 1.2.3.4），IPv6
 * /128 同理。不归一化就会出现「同一条记录既该加又该删」，比对结果永远是漂移。
 */
export function normalizeListItem(value: string): string {
  const raw = (value ?? "").trim();
  const slash = raw.lastIndexOf("/");
  if (slash < 0) return raw;
  const prefix = Number(raw.slice(slash + 1));
  const addr = raw.slice(0, slash);
  if (prefix === 32 && !addr.includes(":")) return addr;
  if (prefix === 128 && addr.includes(":")) return addr;
  return raw;
}

export interface BlocklistDiff {
  toAdd: string[];
  toRemove: string[];
}

/** 与 ops/sync-worker/src/index.ts 的 diffSync 同源的只读版本（**改一处必须改两处**）。 */
export function diffBlocklist(desired: Iterable<string>, existing: Iterable<string>): BlocklistDiff {
  const desiredNorm = new Set([...desired].map(normalizeListItem));
  const existingNorm = new Set([...existing].map(normalizeListItem));
  return {
    toAdd: [...desiredNorm].filter((cidr) => !existingNorm.has(cidr)).sort(),
    toRemove: [...existingNorm].filter((cidr) => !desiredNorm.has(cidr)).sort(),
  };
}

export interface BlocklistSnapshot {
  desired: string[];
  actual: string[];
  diff: BlocklistDiff;
  /** 按名字没找到 List。此时 actual 视为空集，desired 非空就会体现为 toAdd。 */
  listMissing: boolean;
}

export interface BlocklistCheckResult {
  /** 读到了两侧数据、可以下结论。 */
  ok: boolean;
  /** ok=false 时的原因（缺凭据 / D1 / API），不是「漂移」。 */
  reason?: string;
  snapshot?: BlocklistSnapshot;
}

interface CfList {
  id?: string;
  name?: string;
}

async function cfGet(token: string, url: string): Promise<any> {
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error(`CF API ${resp.status} ${url}`);
  return resp.json();
}

/** 按 cursor 读完一页页 items；cursor 不前进或超过上限就抛错，不静默只读第一页。 */
async function readListItems(
  token: string,
  accountId: string,
  listId: string,
): Promise<string[]> {
  const ips: string[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const query = cursor
      ? `?per_page=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `?per_page=${PAGE_SIZE}`;
    const resp = await cfGet(
      token,
      `${CF_API}/accounts/${accountId}/rules/lists/${listId}/items${query}`,
    );
    const result: Array<{ ip?: string }> = resp?.result ?? [];
    for (const item of result) if (item.ip) ips.push(item.ip);
    const next = resp?.result_info?.cursor ?? "";
    if (!next || !result.length) return ips;
    if (next === cursor) {
      throw new Error(`list ${listId}: cursor did not advance (${next})`);
    }
    cursor = next;
  }
  throw new Error(`list ${listId}: more than ${MAX_ITEM_PAGES} pages of items`);
}

export interface BlocklistEnv {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

/**
 * 读两侧并比对。**绝不抛**：缺凭据、D1 失败、API 失败都返回 `{ok:false, reason}`，
 * 由调用方只记日志。
 */
export async function checkBlocklistInvariant(env: BlocklistEnv): Promise<BlocklistCheckResult> {
  const token = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (!token || !accountId) {
    // 没配 secret 就是「没检查」，不是「检查失败」，更不能报警。
    return { ok: false, reason: "missing_credentials" };
  }

  let desired: string[];
  try {
    const rows = await env.DB.prepare("SELECT cidr FROM blocked_ips WHERE active = 1").all<{
      cidr: string;
    }>();
    desired = (rows.results ?? []).map((r) => r.cidr);
  } catch (err) {
    return { ok: false, reason: `d1_error: ${String(err).slice(0, 140)}` };
  }

  try {
    const lists = await cfGet(token, `${CF_API}/accounts/${accountId}/rules/lists?per_page=100`);
    const list: CfList | undefined = (lists?.result ?? []).find(
      (l: CfList) => l.name === LIST_NAME,
    );
    // 只读检查**不创建** List（创建是 sync-worker 的职责）；找不到就按空集比对，
    // desired 非空时自然会以 toAdd 的形式报出来。
    const actual = list?.id ? await readListItems(token, accountId, list.id) : [];
    return {
      ok: true,
      snapshot: {
        desired,
        actual,
        diff: diffBlocklist(desired, actual),
        listMissing: !list?.id,
      },
    };
  } catch (err) {
    return { ok: false, reason: `cf_error: ${String(err).slice(0, 140)}` };
  }
}
