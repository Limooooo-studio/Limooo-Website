/**
 * 每日 03:30 把 D1 里的 active blocked_ips 增量同步到 Cloudflare IP List
 * （原 auto_block.py 的 sync_cloudflare 移植；ipset/iptables 部分随迁移放弃）
 */

interface D1Result<T> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
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

export default {
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(sync(env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!authorized(request, env)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const dryRun = new URL(request.url).searchParams.get("dry-run") === "1";
    const result = await sync(env, { dryRun });
    return Response.json({ ok: true, ...result });
  },
};
