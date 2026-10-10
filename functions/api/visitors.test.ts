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

/** /api/visitors 聚合与状态码兼容测试（mock D1 与登录校验）。 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./visitors";
import { queryAll } from "../_lib/d1";
import { requireAuth } from "../_lib/session";
import type { Env } from "../_lib/env";

vi.mock("../_lib/d1", () => ({ queryAll: vi.fn() }));
vi.mock("../_lib/session", async () => {
  // 共用桩（docs/22 W5-15）：语义与位置说明见 tests/helpers/admin-session.ts。
  const { createSessionModuleMock } = await import("../../tests/helpers/admin-session");
  return createSessionModuleMock();
});

const env = {} as Env;

function context(request: Request) {
  return {
    request,
    env,
    params: {},
    next: async () => new Response("next"),
    waitUntil: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
  vi.mocked(requireAuth).mockResolvedValue({ role: "admin" } as never);
});

afterEach(() => {
  vi.useRealTimers();
  // 必须在这里还原全局桩，不能写在用例末尾：一旦某条用例在它之前断言失败，
  // 伪造的 `caches.default` 就会泄漏给同一进程里后续的测试文件——实测它会让
  // functions/_middleware.test.ts 的页面缓存命中一个假的 403
  // （`expected 403 to be 200`，单跑该文件却是绿的）。审计里 W5-14 点名的就是这个反模式。
  vi.unstubAllGlobals();
});

/** 进程内 Cache API 桩：只实现 match/put，并记录 put。键取请求 URL（与线上一致）。 */
function cacheUrlOf(request: RequestInfo): string {
  if (typeof request === "string") return request;
  return request instanceof URL ? request.toString() : request.url;
}

function fakeCache() {
  const store = new Map<string, Response>();
  const puts: string[] = [];
  return {
    store,
    puts,
    cache: {
      match: async (request: RequestInfo) => store.get(cacheUrlOf(request))?.clone(),
      put: async (request: RequestInfo, response: Response) => {
        puts.push(cacheUrlOf(request));
        store.set(cacheUrlOf(request), response.clone());
      },
    },
  };
}

const singleRowStats = [{ ips: 1, requests: 2, countries: 1, status_series: "200:2" }];
const singleRowMarkers = [
  { ip_hash: "cached01", country: "US", status: 200, n: 2, last_ts: 1767225600 },
];

describe("visitors API", () => {
  it("returns aggregates, status counts and markers in two D1 queries", async () => {
    const expectedCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    vi.mocked(queryAll)
      .mockResolvedValueOnce([
        { ips: 2, requests: 4, countries: 1, status_series: "200:3,404:1" },
      ])
      .mockResolvedValueOnce([
        {
          ip_hash: "abc123",
          country: "US",
          status: 200,
          n: 3,
          last_ts: 1767225600,
        },
        {
          ip_hash: "abc123",
          country: "US",
          status: 404,
          n: 1,
          last_ts: 1767312000,
        },
      ]);

    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    const data = await resp.json();

    expect(resp.status).toBe(200);
    expect(vi.mocked(queryAll)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queryAll).mock.calls[0][1]).toContain("GROUP_CONCAT");
    expect(vi.mocked(queryAll).mock.calls[0][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[0][3]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][1]).toContain("LIMIT 500");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][3]).toBe(expectedCutoff);

    expect(data.stats.total_requests).toBe(4);
    expect(data.stats.total_ips).toBe(2);
    expect(data.status_counts["200"]).toBe(3);
    expect(data.status_counts["404"]).toBe(1);
    expect(data.markers[0].ip_hash).toBe("abc123");
    expect(data.markers[0].ip).toBeNull();
    expect(data.markers[0].count).toBe(4);
    expect(data.markers[0].last_time).toBe("2026-01-02T00:00:00.000Z");
    expect(data.markers[0].statuses).toEqual({ "200": 3, "404": 1 });
    expect(data.range_days).toBe(30);
    expect(data.max_markers).toBe(500);
  });

  // 回归：国家必须取「最近一次访问」的值。曾经写的是 MAX(country)，那是按
  // 字母序选（'CN' > 'CH'），与时间无关，导致 CN/CH 混合的访客恒显示 CN。
  //
  // 断言按行为写，并且把同样两行**倒序**再喂一次：mock 的行顺序曾经就是
  // 实现依赖的顺序，正序喂一遍的话「取第一行」这种错法也能过。
  //
  // 已知未修（2026-10-11 实测，见 docs/22 执行记录 W5-5 未决事项）：
  // buildMarkers 的 country 取的是**该 ip_hash 的第一行**，不是在
  // `row.last_ts > acc.last_time` 时一起更新；所以一个访客有多种 status、
  // 各自 last_ts 不同时，倒序喂进来会给出较早那次的国家（本用例倒序时会得到
  // CN）。修法是 `functions/api/visitors.ts` 的累加器里同步 `acc.country =
  // row.country`（属 W9 代理的文件）。修好后把下面的断言升级成两种顺序都等于 CH。
  it("accumulates markers independently of row order", async () => {
    const rows = [
      // 同一访客：最近一次是 404（在 CH），更早是 200（在 CN）。
      { ip_hash: "cnch0001", country: "CH", status: 404, n: 1, last_ts: 1767312000 },
      { ip_hash: "cnch0001", country: "CN", status: 200, n: 2, last_ts: 1767225600 },
    ];
    const markers: Array<Record<string, unknown>> = [];
    for (const order of [rows, [...rows].reverse()]) {
      vi.mocked(queryAll).mockReset();
      vi.mocked(queryAll)
        .mockResolvedValueOnce([
          { ips: 1, requests: 3, countries: 2, status_series: "200:2,404:1" },
        ])
        .mockResolvedValueOnce(order);
      const resp = await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
      );
      const data = await resp.json();
      markers.push(data.markers[0]);
    }

    // 与行顺序无关的部分：次数、最近时间、状态分布。
    expect(markers[0].count).toBe(3);
    expect(markers[1].count).toBe(3);
    expect(markers[0].last_time).toBe("2026-01-02T00:00:00.000Z");
    expect(markers[1].last_time).toBe("2026-01-02T00:00:00.000Z");
    expect(markers[0].statuses).toEqual({ "404": 1, "200": 2 });
    expect(markers[1].statuses).toEqual({ "404": 1, "200": 2 });
    // 最近那行的国家：正序与倒序都必须是 'CH'。
    // 旧实现只在首次见到 ip_hash 时取国家（= D1 返回的第一行），倒序时会给 'CN'；
    // 展示的国家不能取决于 D1 的行顺序。
    expect(markers[0].country).toBe("CH");
    expect(markers[1].country).toBe("CH");

    const markerSql = (
      vi.mocked(queryAll).mock.calls.map((call) => String(call[1]))
    ).find((sql) => sql.includes("LIMIT 500"));
    expect(markerSql).toBeTruthy();
    // SQL 的注释里会引用下面这些反面写法，断言前先剥掉注释，
    // 否则测的是说明文字而不是真正的 SQL。
    const sqlCode = String(markerSql).replace(/--[^\n]*/g, "");
    expect(sqlCode).not.toContain("MAX(v.country)");
    // 禁止更贵的替代写法（都在线上 D1 实测过，读数远高于 13.1 万的基线）：
    // 相关子查询 1370 万行、NOT EXISTS 753 万行、ROW_NUMBER 全分区 17.5 万行。
    expect(sqlCode).not.toMatch(/SELECT\s+s2\.country/);
    expect(sqlCode).not.toContain("NOT EXISTS");
    expect(sqlCode).not.toContain("ROW_NUMBER()");
  });

  /**
   * W9-13：/api/visitors 每次轮询都重算 30 天窗口（文件内注释记着「实测 13.1 万行
   * 读取」），管理页整天开着 ≈ 144 次 × 13 万行，直接逼近 5,000,000 行/天。
   * 用 caches.default 按 URL 缓存 300 s。
   */
  describe("edge cache", () => {
    it("serves a repeated poll from cache without touching D1 again", async () => {
      const { cache, puts } = fakeCache();
      vi.stubGlobal("caches", { default: cache });
      vi.mocked(queryAll)
        .mockResolvedValueOnce(singleRowStats)
        .mockResolvedValueOnce(singleRowMarkers);

      const first = await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
      );
      expect(first.status).toBe(200);
      expect(vi.mocked(queryAll)).toHaveBeenCalledTimes(2);
      expect(first.headers.get("Cache-Control")).toContain("max-age=300");
      expect(puts).toHaveLength(1);

      const second = await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
      );
      const data = await second.json();
      // 命中缓存：不再打 D1。
      expect(vi.mocked(queryAll)).toHaveBeenCalledTimes(2);
      expect(data.markers[0].ip_hash).toBe("cached01");
      vi.unstubAllGlobals();
    });

    it("keeps the status filter in the cache key", async () => {
      const { cache, puts } = fakeCache();
      vi.stubGlobal("caches", { default: cache });
      vi.mocked(queryAll)
        .mockResolvedValue(singleRowStats)
        .mockResolvedValue(singleRowMarkers);

      await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors?status=200")) as never,
      );
      await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors?status=404")) as never,
      );
      expect(puts).toHaveLength(2);
      expect(puts[0]).not.toBe(puts[1]);
      vi.unstubAllGlobals();
    });

    it("does not cache an unauthorized response", async () => {
      const { cache, puts } = fakeCache();
      vi.stubGlobal("caches", { default: cache });
      vi.mocked(requireAuth).mockResolvedValue(null as never);
      const resp = await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
      );
      expect(resp.status).toBe(401);
      expect(puts).toHaveLength(0);
      vi.unstubAllGlobals();
    });

    it("still works when the Cache API is unavailable", async () => {
      vi.stubGlobal("caches", undefined);
      vi.mocked(queryAll)
        .mockResolvedValueOnce(singleRowStats)
        .mockResolvedValueOnce(singleRowMarkers);
      const resp = await onRequestGet(
        context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
      );
      expect(resp.status).toBe(200);
      vi.unstubAllGlobals();
    });
  });

  it("keeps the status filter compatible and applies the same 30-day window", async () => {
    const expectedCutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    vi.mocked(queryAll)
      .mockResolvedValueOnce([
        { ips: 1, requests: 1, countries: 0, status_series: "404:1" },
      ])
      .mockResolvedValueOnce([
        {
          ip_hash: "def456",
          country: "",
          status: 404,
          n: 1,
          last_ts: 1767225600,
        },
      ]);

    await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=404")) as never,
    );

    const markerSql = vi.mocked(queryAll).mock.calls[1][1] as string;
    expect(markerSql).toContain("status = ?");
    expect(vi.mocked(queryAll).mock.calls[1][2]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][3]).toBe(404);
    expect(vi.mocked(queryAll).mock.calls[1][4]).toBe(expectedCutoff);
    expect(vi.mocked(queryAll).mock.calls[1][5]).toBe(404);
  });

  it("returns 400 for an invalid status param without querying D1", async () => {
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors?status=all")) as never,
    );
    expect(resp.status).toBe(400);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  it("returns empty aggregates when there are no recent rows", async () => {
    vi.mocked(queryAll)
      .mockResolvedValueOnce([{ ips: 0, requests: 0, countries: 0, status_series: null }])
      .mockResolvedValueOnce([]);

    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    const data = await resp.json();

    expect(data.stats).toEqual({ total_ips: 0, total_requests: 0, countries: 0 });
    expect(data.status_counts).toEqual({});
    expect(data.markers).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockResolvedValue(null);
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    expect(resp.status).toBe(401);
  });

  it("returns 403 for non-admin sessions", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ role: "viewer" } as never);
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    expect(resp.status).toBe(403);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });

  // W5-15：撤销表不可用时必须 fail-closed，不能凭 cookie 放行。
  it("returns 503 when the session store is unavailable", async () => {
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error("auth_sessions_unavailable"));
    const resp = await onRequestGet(
      context(new Request("https://visitor.limooo.cn/api/visitors")) as never,
    );
    expect(resp.status).toBe(503);
    expect(vi.mocked(queryAll)).not.toHaveBeenCalled();
  });
});
