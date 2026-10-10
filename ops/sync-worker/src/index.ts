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
 * 每日 03:30 把 D1 里的 active blocked_ips 增量同步到 Cloudflare IP List
 * （原 auto_block.py 的 sync_cloudflare 移植；ipset/iptables 部分随迁移放弃）
 *
 * 失败可见性（2026-10-11 补）：此前 scheduled() 只写 `ctx.waitUntil(sync(env))`，
 * 协程的 rejection 被 waitUntil 静默吞掉 —— cron 面板显示「已运行」，实际一条
 * 都没写进去，且没有任何地方留下痕迹。现在：
 *   1. 每次运行在 D1 worker_runs 落一行（成功/失败都落，失败带 error）；
 *   2. scheduled() 显式 await + try/catch，失败打结构化单行 JSON 到 Workers 日志；
 *   3. GET /?health=1 只报健康状态（不触发同步），返回 { ok, job, lastRun }。
 * 三条都不参与热路径读：运行记录只写不读，健康端点才读。
 */

import { insertRun, lastRun, runStartedAt, updateRun, type RunRow } from "./runlog";

/**
 * 结构化单行 JSON 运行日志（风格对齐 functions/_lib/logging.ts 的 logEvent：
 * 一行一个完整 JSON、字段名可 grep）。
 *
 * 失败走 console.error、其余走 console.log：Cloudflare 日志面板与 `wrangler
 * tail` 都能按级别筛，因此 `outcome:"failed"` 是**可检索**的 —— 这正是本次修
 * 的核心（此前 waitUntil 把 rejection 吞掉，日志里连一行都没有）。
 */
function logRun(fields: Record<string, unknown> & { outcome?: string }): void {
  const payload: { event: string; ts: number; job: string; outcome?: string } & Record<
    string,
    unknown
  > = {
    event: JOB,
    ts: runStartedAt(),
    job: JOB,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (payload.outcome === "failed") console.error(line);
  else console.log(line);
}

interface D1Result<T> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

interface Env {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SYNC_TOKEN: string;
}

const LIST_NAME = "limooo_blocklist";
const API = "https://api.cloudflare.com/client/v4";
const BATCH = 200;
// 列表项接口的 per_page 上限是 500；传 1000 会返回 400
// （code 10027 "invalid or expired cursor"），导致整次同步失败。
const PAGE_SIZE = 500;
// items 接口按 cursor 翻页且没有「最后一页」标志；给一个迭代上限，避免
// 上游行为变化（忽略 cursor、cursor 永不结束）时死循环到 Worker 被杀。
const MAX_ITEM_PAGES = 20;
// bulk_operations 轮询：40 次 × 2s ≈ 80s，超时按失败处理（不再静默当成功）。
const OPERATION_POLLS = 40;
const OPERATION_POLL_MS = 2000;

/** 运行记录里的任务名：与 ops/migrations/018_worker_runs.sql 的 job 列取值一致。 */
export const JOB = "blocklist_sync";

export interface SyncResult {
  toAdd: string[];
  toRemove: string[];
}

/**
 * Cloudflare IP List 会把 IPv4 /32 归一化成裸 IP（写入 1.2.3.4/32 读回 1.2.3.4），
 * IPv6 /128 同理。若两侧都用原始字符串比较，同一条记录会被判成
 * “既该加又该删”，每次同步都反复删除重加。这里统一成可比形式。
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

export function diffSync(
  desired: Set<string>,
  existing: Map<string, string>,
): SyncResult {
  // 两侧都归一化后再比较，避免 /32 与裸 IP 的不一致。
  const desiredNorm = new Set([...desired].map(normalizeListItem));
  const existingNorm = new Set([...existing.keys()].map(normalizeListItem));
  const toAdd = [...desiredNorm].filter((cidr) => !existingNorm.has(cidr));
  const toRemove = [...existingNorm].filter((cidr) => !desiredNorm.has(cidr));
  return { toAdd, toRemove };
}

async function cf(token: string, method: string, url: string, body?: unknown): Promise<any> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`CF API ${resp.status} ${url}`);
  return resp.json();
}

/**
 * 等待一次 bulk operation 结束。
 *
 * 关键点（docs/22 W7-6）：`failed` 与轮询超时都必须**抛错**。此前两者都当成
 * 正常返回，调用方照样打印 `synced: +N -M`，于是「一条都没写进去」看起来像成功。
 */
async function waitOperation(token: string, accountId: string, operationId?: string): Promise<void> {
  if (!operationId) return;
  for (let i = 0; i < OPERATION_POLLS; i++) {
    const resp = await cf(
      token,
      "GET",
      `${API}/accounts/${accountId}/rules/lists/bulk_operations/${operationId}`,
    );
    const status = resp?.result?.status;
    if (status === "completed") return;
    if (status === "failed") {
      const detail = resp?.result?.error ?? resp?.errors ?? resp?.result;
      throw new Error(
        `CF list bulk operation ${operationId} failed: ${JSON.stringify(detail).slice(0, 200)}`,
      );
    }
    await new Promise((r) => setTimeout(r, OPERATION_POLL_MS));
  }
  throw new Error(
    `CF list bulk operation ${operationId} did not finish within ` +
      `${OPERATION_POLLS} polls (${(OPERATION_POLLS * OPERATION_POLL_MS) / 1000}s)`,
  );
}

/**
 * 读取 IP List 的全部条目。
 *
 * 翻页用 `result_info.cursor`（Cloudflare 已不再支持 `page=`；继续传 page 时
 * 上游会返回同一页，旧实现因此可能死循环）。cursor 不前进或超过
 * MAX_ITEM_PAGES 时抛错，绝不安静地只同步第一页。
 */
async function listItems(token: string, accountId: string, listId: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  let cursor = "";
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const query = cursor
      ? `?per_page=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `?per_page=${PAGE_SIZE}`;
    const resp = await cf(
      token,
      "GET",
      `${API}/accounts/${accountId}/rules/lists/${listId}/items${query}`,
    );
    const result: Array<{ ip: string; id: string }> = resp?.result ?? [];
    for (const item of result) items.set(item.ip, item.id);
    const next = resp?.result_info?.cursor ?? "";
    if (!next || !result.length) return items;
    if (next === cursor) {
      throw new Error(
        `list ${listId}: cursor did not advance (${next}); refusing to re-read the same page`,
      );
    }
    cursor = next;
  }
  throw new Error(
    `list ${listId}: more than ${MAX_ITEM_PAGES} pages of items; refusing to loop forever`,
  );
}

export async function sync(
  env: Env,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.log("[cf] missing credentials, skipping");
    return { toAdd: [], toRemove: [] };
  }

  // 只同步 active 行：admin/unblock 的软删除墓碑不会重新出现在 CF List。
  const rows = await env.DB.prepare(
    "SELECT cidr FROM blocked_ips WHERE active = 1",
  ).all<{ cidr: string }>();
  const desired = new Set((rows.results ?? []).map((r) => r.cidr));

  const lists = await cf(token, "GET", `${API}/accounts/${accountId}/rules/lists?per_page=100`);
  let list = (lists?.result ?? []).find((l: { name: string }) => l.name === LIST_NAME);
  if (!list) {
    const created = await cf(token, "POST", `${API}/accounts/${accountId}/rules/lists`, {
      name: LIST_NAME,
      kind: "ip",
      description: "auto-blocked networks from nginx logs",
    });
    list = created?.result;
  }
  if (!list?.id) throw new Error("list not found/created");

  const existing = await listItems(token, accountId, list.id);
  const { toAdd, toRemove } = diffSync(desired, existing);
  if (options.dryRun) {
    console.log(`[cf] dry-run: +${toAdd.length} -${toRemove.length}`);
    return { toAdd, toRemove };
  }

  for (let i = 0; i < toAdd.length; i += BATCH) {
    const chunk = toAdd.slice(i, i + BATCH).map((ip) => ({ ip }));
    const resp = await cf(token, "POST", `${API}/accounts/${accountId}/rules/lists/${list.id}/items`, chunk);
    await waitOperation(token, accountId, resp?.result?.operation_id);
  }
  // toRemove 是归一化后的值，不能直接拿来 existing.get()：
  // /32 与裸 IP 形式不一致时取不到列表项 id，删除会被静默跳过。
  const idByNormalized = new Map<string, string>();
  for (const [rawIp, id] of existing) idByNormalized.set(normalizeListItem(rawIp), id);
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const chunk = toRemove
      .slice(i, i + BATCH)
      .map((ip) => ({ id: idByNormalized.get(ip) }))
      .filter((x): x is { id: string } => Boolean(x.id));
    if (!chunk.length) continue;
    const resp = await cf(token, "DELETE", `${API}/accounts/${accountId}/rules/lists/${list.id}/items`, {
      items: chunk,
    });
    await waitOperation(token, accountId, resp?.result?.operation_id);
  }
  console.log(`[cf] synced: +${toAdd.length} -${toRemove.length}`);
  return { toAdd, toRemove };
}

/**
 * scheduled / fetch 共用的入口：跑一次同步，并把这次运行写成 worker_runs 的一行。
 *
 * 与 sync() 的关键区别是**谁负责把失败记下来**。sync() 照旧只做同步并抛错，
 * 由这里在最外层收口，保证「抛了」跟「记了」不会分家：
 *   - 抛错  → outcome='failed' + error 文本，然后**继续往外抛**（日志仍可检索）；
 *   - 成功  → outcome='ok' + 本次增量；
 *   - 缺凭据提前返回 → outcome='skipped'（同步本身没跑，不是失败）。
 *
 * 运行记录写入失败只 console.error，绝不影响同步本身（fail-open，与
 * functions/_lib/logging.ts 的写失败处理一致）；记录读的失败同理，由调用方兜。
 */
export async function runSync(
  env: Env,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult & { runId: number | null }> {
  const startedAt = runStartedAt();
  const runId = await insertRun(env.DB, JOB, startedAt);
  const missingCredentials = !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID;
  logRun({ outcome: "started", dry_run: options.dryRun === true });
  try {
    const result = await sync(env, options);
    const outcome = missingCredentials ? "skipped" : "ok";
    await updateRun(env.DB, runId, {
      finishedAt: runStartedAt(),
      outcome,
      added: result.toAdd.length,
      removed: result.toRemove.length,
    });
    logRun({
      outcome,
      added: result.toAdd.length,
      removed: result.toRemove.length,
      duration_ms: runStartedAt() - startedAt,
    });
    return { ...result, runId };
  } catch (error) {
    await updateRun(env.DB, runId, {
      finishedAt: runStartedAt(),
      outcome: "failed",
      error: String(error),
    });
    logRun({ outcome: "failed", error: String(error), duration_ms: runStartedAt() - startedAt });
    throw error;
  }
}

/**
 * 手动触发端点的鉴权：比对 Authorization: Bearer <SYNC_TOKEN>。
 *
 * 这个 worker 只在 *.workers.dev 上可达，而 workers.dev 不属于本账户，
 * 无法用 zone 级 mTLS/Client Certificate 保护，因此用共享密钥。
 * 定时任务（scheduled）走内部调用，不经过这里。
 *
 * 未配置 SYNC_TOKEN 时 fail-closed（拒绝所有 HTTP 调用），避免"忘了设
 * secret 就等于开放"。
 */
export function authorized(request: Request, env: Env): boolean {
  const expected = (env.SYNC_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length).trim();
  if (!provided || provided.length !== expected.length) return false;
  // 长度相等时逐字符比较，避免提前返回泄露前缀信息。
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** 只报健康状态（不触发同步）：最近一次运行记录 + 表不可用时的原因。 */
export async function health(env: Env): Promise<{ ok: boolean; job: string; lastRun: RunRow | null; error?: string }> {
  try {
    return { ok: true, job: JOB, lastRun: await lastRun(env.DB, JOB) };
  } catch (error) {
    // 读不到运行记录不等于同步失败，如实区分：ok 仍为真，附上读失败原因。
    return { ok: true, job: JOB, lastRun: null, error: String(error) };
  }
}

export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    // 必须显式 await 进一个 try/catch：`ctx.waitUntil(sync(env))` 会把 rejection
    // 吞掉，cron 面板照样显示成功 —— 同步连续失败 20 天也无人发现（2026-10-11）。
    const work = (async () => {
      try {
        const result = await runSync(env);
        // runSync 已经打过一行 outcome='ok' 的结构化日志；这里只补一条 cron
        // 语义的收尾行，让「cron 到底跑没跑完」在日志里也一眼可见。
        logRun({
          outcome: "scheduled_ok",
          added: result.toAdd.length,
          removed: result.toRemove.length,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "blocklist_sync",
            ts: runStartedAt(),
            job: JOB,
            outcome: "failed",
            stage: "scheduled",
            error: String(error),
          }),
        );
      }
    })();
    /**
     * 同时递给 waitUntil 与本地 await：前者保证 isolate 在响应后仍把活干完，后者
     * 保证这次的 promise 被显式观察过 —— 这正是修掉「rejection 被静默吞掉」的关键。
     */
    ctx.waitUntil(work);
    await work;
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    // 鉴权先于一切分支：健康端点也只在带上 SYNC_TOKEN 时才回话。
    if (!authorized(request, env)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("health") === "1") {
      return Response.json(await health(env));
    }
    const dryRun = url.searchParams.get("dry-run") === "1";
    try {
      const result = await runSync(env, { dryRun });
      // 保留原有 `ok:true + toAdd/toRemove` 形状（.zshrc 的 _limooo_sync_cf 与
      // 其它调用方依赖它），新增字段只做增量。
      return Response.json({
        ok: true,
        status: "synced",
        synced: true,
        dryRun,
        toAdd: result.toAdd,
        toRemove: result.toRemove,
        runId: result.runId,
        lastRun: await lastRun(env.DB, JOB),
      });
    } catch (error) {
      // 失败不再只回 { ok:false }：把 error 与刚写下的那条失败运行记录一并返回，
      // 调用方不必再翻日志才知道「为什么没推上去」。
      return Response.json(
        {
          ok: false,
          status: "error",
          synced: false,
          dryRun,
          error: String(error),
          lastRun: await lastRun(env.DB, JOB),
        },
        { status: 502 },
      );
    }
  },
};
