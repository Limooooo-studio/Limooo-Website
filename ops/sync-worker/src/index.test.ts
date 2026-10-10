/** sync-worker 差异计算与 dry-run 基础测试（docs/10）。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { authorized, diffSync, normalizeListItem, sync } from "./index";

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
