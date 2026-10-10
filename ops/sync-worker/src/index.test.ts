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

/** sync-worker 差异计算与 dry-run 基础测试（docs/10）。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { authorized, diffSync, normalizeListItem, runSync, sync } from "./index";

// scheduled 是 default export 的一个方法；单拎出来让用例读起来更像 cron。
const scheduled = worker.scheduled;

const envWith = (token: string) => ({ SYNC_TOKEN: token }) as never;
const reqWith = (auth?: string) =>
  new Request("https://limooo-blocklist-sync.limooo.workers.dev/", {
    headers: auth ? { Authorization: auth } : {},
  });

describe("sync-worker", () => {
  it("computes add/remove diff", () => {
    const result = diffSync(
      new Set(["1.2.3.0/24", "2001:db8::/64"]),
      new Map([
        ["1.2.3.0/24", "item-1"],
        ["4.5.6.0/24", "item-2"],
      ]),
    );
    expect(result.toAdd).toContain("2001:db8::/64");
    expect(result.toRemove).toContain("4.5.6.0/24");
    expect(result.toAdd).not.toContain("1.2.3.0/24");
  });

  it("skips without credentials", async () => {
    const env = {
      DB: { prepare: () => ({ all: async () => ({ results: [], success: true }) }) },
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    } as never;
    const result = await sync(env);
    expect(result).toEqual({ toAdd: [], toRemove: [] });
  });
});

/**
 * 回归（2026-09-21 实测）：Cloudflare IP List 会把 /32 归一化成裸 IP
 * （写入 1.2.3.4/32，读回 1.2.3.4）。若直接用原始字符串比较，同一条记录
 * 会同时出现在 toAdd 与 toRemove，导致每次同步反复删除重加。
 */
describe("normalizeListItem", () => {
  it("normalises IPv4 /32 and IPv6 /128 to a bare IP", () => {
    expect(normalizeListItem("1.2.3.4/32")).toBe("1.2.3.4");
    expect(normalizeListItem("2001:db8::1/128")).toBe("2001:db8::1");
  });

  it("keeps real network prefixes; bare IPs pass through", () => {
    expect(normalizeListItem("1.2.3.0/24")).toBe("1.2.3.0/24");
    expect(normalizeListItem("2001:db8::/64")).toBe("2001:db8::/64");
    expect(normalizeListItem("1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("diffSync and /32 normalisation", () => {
  it("does not re-add an existing /32", () => {
    // D1 是 /32，Cloudflare 存裸 IP —— 修复前这里既 toAdd 又 toRemove。
    const result = diffSync(
      new Set(["1.2.3.4/32", "5.6.7.0/24"]),
      new Map([
        ["1.2.3.4", "id1"],
        ["9.9.9.9", "id2"],
      ]),
    );
    expect(result.toAdd).toEqual(["5.6.7.0/24"]);
    expect(result.toRemove).toEqual(["9.9.9.9"]);
  });

  it("no-op when both sides agree (idempotent)", () => {
    const result = diffSync(new Set(["1.2.3.4/32"]), new Map([["1.2.3.4", "id1"]]));
    expect(result.toAdd).toEqual([]);
    expect(result.toRemove).toEqual([]);
  });

  it("a record never appears in both toAdd and toRemove", () => {
    const result = diffSync(new Set(["1.2.3.4/32"]), new Map([["1.2.3.4", "id1"]]));
    const overlap = result.toAdd.filter((ip) => result.toRemove.includes(ip));
    expect(overlap).toEqual([]);
  });
});

/**
 * 手动触发端点的鉴权（workers.dev 无法用 zone 级 mTLS，改用共享密钥）。
 * 关键行为：未配置 SYNC_TOKEN 时必须 fail-closed。
 */
describe("authorized", () => {
  it("allows a correct token", () => {
    expect(authorized(reqWith("Bearer s3cret-token"), envWith("s3cret-token"))).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(authorized(reqWith(), envWith("s3cret-token"))).toBe(false);
  });

  it("rejects a wrong or wrong-length token", () => {
    expect(authorized(reqWith("Bearer wrong"), envWith("s3cret-token"))).toBe(false);
    expect(authorized(reqWith("Bearer s3cret-toke"), envWith("s3cret-token"))).toBe(false);
    expect(authorized(reqWith("Bearer s3cret-tokenX"), envWith("s3cret-token"))).toBe(false);
  });

  it("rejects a missing Bearer prefix", () => {
    expect(authorized(reqWith("s3cret-token"), envWith("s3cret-token"))).toBe(false);
  });

  it("fails closed when SYNC_TOKEN is unset", () => {
    expect(authorized(reqWith("Bearer anything"), envWith(""))).toBe(false);
    expect(authorized(reqWith("Bearer "), envWith(""))).toBe(false);
    expect(authorized(reqWith("Bearer undefined"), { SYNC_TOKEN: undefined } as never)).toBe(false);
  });
});

/**
 * docs/22 W7-6 / W7-7：bulk operation 失败要抛、翻页要用 cursor 且有上限。
 *
 * 这些用例 stub 掉 fetch，绝不访问 Cloudflare：只验证 sync() 的控制流。
 */
const LIST_ID = "list-1";
const API = "https://api.cloudflare.com/client/v4";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const syncEnv = (cidrs: string[]) =>
  ({
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_ACCOUNT_ID: "account",
    DB: {
      prepare: () => ({
        all: async () => ({ results: cidrs.map((cidr) => ({ cidr })), success: true }),
      }),
    },
  }) as never;

interface StubCall {
  method: string;
  url: string;
}

/** 记录每次请求；handler 决定返回什么。 */
function stubFetch(
  handler: (call: StubCall) => unknown,
): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { method: (init?.method ?? "GET").toUpperCase(), url: String(input) };
      calls.push(call);
      return json(handler(call));
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("waitOperation failures (W7-6)", () => {
  it("rejects when the bulk operation reports failed", async () => {
    stubFetch(({ url }) => {
      if (url.includes("/rules/lists?per_page=")) return { result: [{ name: "limooo_blocklist", id: LIST_ID }] };
      if (url.includes("/items?") && url.includes("cursor=") === false)
        return { result: [], result_info: {} };
      if (url.includes("/items")) return { result: { operation_id: "op-add" } };
      if (url.includes("/bulk_operations/op-add")) return { result: { status: "failed" } };
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(sync(syncEnv(["1.2.3.0/24"]), {})).rejects.toThrow(/op-add.*failed|failed/);
  });

  it("returns normally when the bulk operation completes", async () => {
    const calls = stubFetch(({ method, url }) => {
      if (url.includes("/rules/lists?per_page=")) return { result: [{ name: "limooo_blocklist", id: LIST_ID }] };
      if (url.includes("/items") && method === "GET") return { result: [], result_info: {} };
      if (url.includes("/items") && method === "POST") return { result: { operation_id: "op-add" } };
      if (url.includes("/bulk_operations/op-add")) return { result: { status: "completed" } };
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(sync(syncEnv(["1.2.3.0/24"]), {})).resolves.toEqual({
      toAdd: ["1.2.3.0/24"],
      toRemove: [],
    });
    expect(calls.some((c) => c.url.includes("/bulk_operations/op-add"))).toBe(true);
  });

  it("rejects when the bulk operation never finishes", async () => {
    vi.useFakeTimers();
    stubFetch(({ url }) => {
      if (url.includes("/rules/lists?per_page=")) return { result: [{ name: "limooo_blocklist", id: LIST_ID }] };
      if (url.includes("/items") && url.includes("operation") === false && url.endsWith("per_page=500"))
        return { result: [], result_info: {} };
      if (url.endsWith("/items")) return { result: { operation_id: "op-slow" } };
      if (url.includes("/bulk_operations/op-slow")) return { result: { status: "pending" } };
      throw new Error(`unexpected request: ${url}`);
    });

    const pending = expect(sync(syncEnv(["1.2.3.0/24"]), {})).rejects.toThrow(/did not finish/);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
  });
});

describe("cursor pagination (W7-7)", () => {
  const listResp = { result: [{ name: "limooo_blocklist", id: LIST_ID }] };

  it("follows result_info.cursor and never sends page=", async () => {
    const calls = stubFetch(({ method, url }) => {
      if (url.includes("/rules/lists?per_page=")) return listResp;
      if (method === "GET" && url.includes("/items?per_page=500") && !url.includes("cursor=")) {
        return { result: [{ ip: "1.2.3.0/24", id: "i1" }], result_info: { cursor: "cursor-2" } };
      }
      if (method === "GET" && url.includes("cursor=cursor-2")) {
        return { result: [{ ip: "4.5.6.0/24", id: "i2" }], result_info: {} };
      }
      if (method === "POST" && url.endsWith("/items")) return { result: { operation_id: "op-add" } };
      if (method === "DELETE" && url.endsWith("/items")) return { result: { operation_id: "op-del" } };
      if (url.includes("/bulk_operations/")) return { result: { status: "completed" } };
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const result = await sync(syncEnv(["1.2.3.0/24", "9.9.9.9"]), {});

    // 第二页的 4.5.6.0/24 必须被看见（否则会被重复添加、且漏删）。
    expect(result.toAdd).toEqual(["9.9.9.9"]);
    expect(result.toRemove).toEqual(["4.5.6.0/24"]);
    expect(calls.some((c) => c.url.includes("cursor=cursor-2"))).toBe(true);
    // 注意别把 `per_page=` 当成 `page=`：这里要求真的没有 page 参数。
    expect(calls.some((c) => /[?&]page=/.test(c.url))).toBe(false);
  });

  it("refuses to loop forever when the upstream keeps handing out cursors", async () => {
    let page = 0;
    const calls = stubFetch(({ method, url }) => {
      if (url.includes("/rules/lists?per_page=")) return listResp;
      if (method === "GET" && url.includes("/items")) {
        page += 1;
        return { result: [{ ip: `10.0.0.${page}/32`, id: `i${page}` }], result_info: { cursor: `c${page}` } };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await expect(sync(syncEnv(["1.2.3.0/24"]), {})).rejects.toThrow(/refusing to loop forever/);
    expect(calls.filter((c) => c.url.includes("/items")).length).toBeLessThanOrEqual(21);
  });

  it("throws when the upstream echoes the same cursor back", async () => {
    stubFetch(({ method, url }) => {
      if (url.includes("/rules/lists?per_page=")) return listResp;
      if (method === "GET" && url.includes("/items")) {
        return { result: [{ ip: "1.2.3.0/24", id: "i1" }], result_info: { cursor: "same" } };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await expect(sync(syncEnv(["1.2.3.0/24"]), {})).rejects.toThrow(/cursor did not advance/);
  });
});

/**
 * 失败可见性（2026-10-11）：把「同步失败只能在 Workers 日志里人肉翻」变成
 * ① worker_runs 落一行、② scheduled 打结构化单行 JSON、③ `?health=1` 可查。
 *
 * 这些用例全部 stub 掉 fetch 与 DB，不访问 Cloudflare，也不碰真实 D1。
 */
interface RunCall {
  sql: string;
  values: unknown[];
}

const mockRunDb = () => {
  const calls: RunCall[] = [];
  let nextId = 1;
  let latest: Record<string, unknown> | undefined;
  const db = {
    prepare(sql: string) {
      const call: RunCall = { sql, values: [] };
      calls.push(call);
      // sync() 用 `prepare(sql).all()`（无 bind），runlog 用 `prepare(sql).bind(...).all()`
      // 与 `.run()`；两种形状都要在，否则桩会把真正的调用签名挡掉。
      return {
        all: async () => {
          if (/INSERT INTO worker_runs/.test(sql)) return { results: [{ id: nextId++ }], success: true };
          if (/FROM worker_runs/.test(sql)) return { results: latest ? [{ ...latest }] : [], success: true };
          if (/FROM blocked_ips/.test(sql)) return { results: [{ cidr: "1.2.3.0/24" }], success: true };
          return { results: [], success: true };
        },
        bind(...values: unknown[]) {
          call.values = values;
          return {
            all: async () => {
              if (/INSERT INTO worker_runs/.test(sql)) return { results: [{ id: nextId++ }], success: true };
              if (/FROM worker_runs/.test(sql)) return { results: latest ? [{ ...latest }] : [], success: true };
              if (/FROM blocked_ips/.test(sql)) return { results: [{ cidr: "1.2.3.0/24" }], success: true };
              return { results: [], success: true };
            },
            run: async () => {
              if (/UPDATE worker_runs/.test(sql)) {
                const [finished_at, outcome, added, removed, error, dry_run, id] = call.values;
                latest = { id, job: "blocklist_sync", finished_at, outcome, added, removed, error, dry_run };
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db, calls };
};

const captureConsole = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return { logs, errors };
};

/** CF 调用按顺序成功，第 failAfter 次起抛错；返回访问过的 URL 列表。 */
function stubCfFailAfter(failAfter: number): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length > failAfter) throw new Error("CF API 500 (simulated upstream failure)");
      if (String(input).includes("/rules/lists?per_page=")) {
        return json({ result: [{ name: "limooo_blocklist", id: LIST_ID }] });
      }
      return json({ result: [], result_info: {} });
    }),
  );
  return urls;
}

const fetchEnv = (parts: ReturnType<typeof mockRunDb>, syncToken = "s3cret-token") =>
  ({
    DB: parts.db,
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_ACCOUNT_ID: "account",
    SYNC_TOKEN: syncToken,
  }) as never;

describe("run history records every run", () => {
  it("writes outcome=failed with the error text when the sync throws", async () => {
    const parts = mockRunDb();
    const { errors } = captureConsole();
    stubCfFailAfter(1);

    await expect(runSync(fetchEnv(parts))).rejects.toThrow(/simulated upstream failure/);

    const update = parts.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.values[1]).toBe("failed");
    expect(String(update!.values[4])).toMatch(/simulated upstream failure/);
    // 失败必须同时出现在 Workers 日志里，且是单行可检索 JSON。
    const failedLine = errors.find((l) => l.includes('"outcome":"failed"'));
    expect(failedLine).toBeDefined();
    const parsed = JSON.parse(failedLine!);
    expect(parsed.event).toBe("blocklist_sync");
    expect(parsed.error).toMatch(/simulated upstream failure/);
  });

  it("writes outcome=ok with the added/removed counts on success", async () => {
    const parts = mockRunDb();
    captureConsole();
    stubCfFailAfter(99);

    const result = await runSync(fetchEnv(parts));

    expect(result.toAdd).toEqual(["1.2.3.0/24"]);
    const insert = parts.calls.find((c) => /INSERT INTO worker_runs/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.values[0]).toBe("blocklist_sync");
    const update = parts.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update!.values[1]).toBe("ok");
    expect(update!.values[2]).toBe(1);
    expect(update!.values[3]).toBe(0);
  });

  it("fails open when the run record cannot be written", async () => {
    const { errors } = captureConsole();
    stubCfFailAfter(99);
    const brokenDb = {
      prepare(sql: string) {
        const rows = async () =>
          /worker_runs/.test(sql)
            ? Promise.reject(new Error("no such table: worker_runs"))
            : { results: [{ cidr: "1.2.3.0/24" }], success: true };
        return {
          all: rows,
          bind: () => ({
            all: rows,
            run: async () => {
              throw new Error("no such table: worker_runs");
            },
          }),
        };
      },
    };
    const env = {
      DB: brokenDb,
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "account",
      SYNC_TOKEN: "s3cret-token",
    } as never;

    // 记账失败绝不能把同步本身带崩。
    await expect(runSync(env)).resolves.toMatchObject({ runId: null });
    expect(errors.some((l) => l.includes("worker_run_store_error"))).toBe(true);
  });

  it("marks a dry run as dry_run=1 so it cannot be mistaken for a real sync", async () => {
    const parts = mockRunDb();
    captureConsole();
    stubCfFailAfter(99);

    await runSync(fetchEnv(parts), { dryRun: true });

    const update = parts.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update!.values[1]).toBe("ok");
    expect(update!.values[5]).toBe(1);
  });

  it("records dry_run=0 for a real sync", async () => {
    const parts = mockRunDb();
    captureConsole();
    stubCfFailAfter(99);

    await runSync(fetchEnv(parts), {});

    const update = parts.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update!.values[1]).toBe("ok");
    expect(update!.values[5]).toBe(0);
  });

  it("the scheduled handler records and logs a failure instead of swallowing it", async () => {
    const parts = mockRunDb();
    const { errors } = captureConsole();
    stubCfFailAfter(1);
    const waited: Promise<unknown>[] = [];

    await scheduled({}, fetchEnv(parts), { waitUntil: (p) => waited.push(p) });

    expect(parts.calls.some((c) => /UPDATE worker_runs/.test(c.sql) && c.values[1] === "failed")).toBe(true);
    expect(errors.some((l) => l.includes('"outcome":"failed"'))).toBe(true);
    expect(waited).toHaveLength(1);
    // scheduled 自己的收口行必须带 stage="scheduled" —— 否则把 catch 退回成
    // 「静默吞掉」时，runSync 那行日志照样还在，用例就抓不到这个退化。
    const scheduledLine = errors
      .map((l) => JSON.parse(l))
      .find((line) => line.stage === "scheduled");
    expect(scheduledLine).toMatchObject({ event: "blocklist_sync", outcome: "failed" });
    expect(scheduledLine.error).toMatch(/simulated upstream failure/);
  });
});

describe("health endpoint", () => {
  it("requires SYNC_TOKEN (401 without it, even for the health shape)", async () => {
    const parts = mockRunDb();
    const unauth = await worker.fetch(new Request("https://sync.example.com/?health=1"), fetchEnv(parts));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ ok: false, error: "unauthorized" });
    // fail-closed：没配 SYNC_TOKEN 时即使是健康端点也不放行。
    const noSecret = await worker.fetch(new Request("https://sync.example.com/?health=1"), fetchEnv(parts, ""));
    expect(noSecret.status).toBe(401);
  });

  it("returns ok + lastRun for an authorized caller and does not sync", async () => {
    const parts = mockRunDb();
    captureConsole();
    const urls = stubCfFailAfter(99);
    await runSync(fetchEnv(parts));
    urls.length = 0;

    const resp = await worker.fetch(
      new Request("https://sync.example.com/?health=1", { headers: { Authorization: "Bearer s3cret-token" } }),
      fetchEnv(parts),
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.job).toBe("blocklist_sync");
    expect(body.lastRun).toMatchObject({ job: "blocklist_sync", outcome: "ok", added: 1, removed: 0 });
    // 健康端点只报告，绝不触发同步（不碰 Cloudflare API）。
    expect(urls).toEqual([]);
  });

  it("keeps the manual trigger shape (ok + toAdd/toRemove) and adds runId", async () => {
    const parts = mockRunDb();
    captureConsole();
    stubCfFailAfter(99);

    const resp = await worker.fetch(
      new Request("https://sync.example.com/", { headers: { Authorization: "Bearer s3cret-token" } }),
      fetchEnv(parts),
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.toAdd).toEqual(["1.2.3.0/24"]);
    expect(body.toRemove).toEqual([]);
    expect(body.lastRun).toMatchObject({ outcome: "ok" });
  });

  it("reports a failed manual trigger as 502 with the error and the recorded run", async () => {
    const parts = mockRunDb();
    captureConsole();
    stubCfFailAfter(1);

    const resp = await worker.fetch(
      new Request("https://sync.example.com/", { headers: { Authorization: "Bearer s3cret-token" } }),
      fetchEnv(parts),
    );

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/simulated upstream failure/);
    expect(body.lastRun).toMatchObject({ outcome: "failed" });
  });
});
