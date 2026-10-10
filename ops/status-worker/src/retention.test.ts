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
 * D1 保留任务测试（docs/22 W5-8）。
 *
 * `runRetention` 每天对**生产** D1 发 DELETE（scheduled handler 调用），却一行
 * 测试都没有：表名与时间戳列是从两张字符串映射里运行期拼出来的，写错一个名字
 * 就是「清理静默失效」或「删错表」。这里用最小 D1 stub 把 SQL、绑定参数、窗口、
 * 失败隔离全部锁住。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUCKETS, DAY_SECONDS, TIMESTAMP_COLUMNS, runRetention } from "./retention";

interface Call {
  sql: string;
  values: unknown[];
  meta: { changes: number } | undefined;
}

/** 记录 prepare/bind；按表名决定返回的 changes 或抛错。 */
function fakeDb(options: { failTables?: string[]; changes?: number } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          calls.push({
            sql,
            values,
            meta: options.failTables?.some((table) => sql.includes(`FROM ${table} `))
              ? undefined
              : { changes: options.changes ?? 0 },
          });
          return statement;
        },
        run: async () => {
          const last = calls[calls.length - 1];
          if (last.meta === undefined) throw new Error("D1_ERROR: no such column");
          return { success: true, meta: last.meta };
        },
      };
      return statement;
    },
  };
  return { db: db as never, calls };
}

const NOW = 1_800_000_000;

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("retention buckets", () => {
  it("covers the seven documented tables with whole-day windows", () => {
    expect(Object.keys(BUCKETS).sort()).toEqual([
      "auth_sessions",
      "events",
      "heartbeats",
      "probe_uptime_daily",
      "ray_log_v2",
      "visitor_rollups",
      "visitors_v2",
    ]);
    for (const [table, seconds] of Object.entries(BUCKETS)) {
      expect(seconds, `${table} window`).toBeGreaterThan(0);
      expect(seconds % DAY_SECONDS, `${table} window must be whole days`).toBe(0);
    }
    // 只有这三张表的时间戳列不是默认的 ts。
    expect(TIMESTAMP_COLUMNS).toEqual({
      visitor_rollups: "last_ts",
      probe_uptime_daily: "day",
      auth_sessions: "exp",
    });
  });

  it("prunes auth_sessions only well after the session TTL", async () => {
    // 每次登录写一行 auth_sessions，没有清理就无限增长（docs/22 W9-18）。
    // 但窗口必须**长于**会话 TTL，否则会删掉仍在用的会话（登录态被踢）。
    const sessionTtlSeconds = 2_592_000; // config-contract.json: session_ttl_seconds
    expect(BUCKETS.auth_sessions).toBeGreaterThan(sessionTtlSeconds);
    expect(TIMESTAMP_COLUMNS.auth_sessions).toBe("exp");

    const { db, calls } = fakeDb({ changes: 2 });
    await runRetention({ DB: db }, NOW);
    const call = calls.find((entry) => entry.sql.startsWith("DELETE FROM auth_sessions "));
    expect(call).toBeDefined();
    expect(call!.sql).toBe("DELETE FROM auth_sessions WHERE exp < ?1");
    expect(call!.values).toEqual([NOW - BUCKETS.auth_sessions]);
  });

  it("deletes one table at a time with the configured window and column", async () => {
    const { db, calls } = fakeDb({ changes: 7 });
    const results = await runRetention({ DB: db }, NOW);

    expect(results).toHaveLength(Object.keys(BUCKETS).length);
    for (const [table, seconds] of Object.entries(BUCKETS)) {
      const column = TIMESTAMP_COLUMNS[table] ?? "ts";
      const call = calls.find((entry) => entry.sql.startsWith(`DELETE FROM ${table} `));
      expect(call, `DELETE for ${table}`).toBeDefined();
      expect(call!.sql).toBe(`DELETE FROM ${table} WHERE ${column} < ?1`);
      // 截断值必须走绑定参数，不能拼进 SQL。
      expect(call!.sql).not.toContain(String(NOW - seconds));
      expect(call!.values).toEqual([NOW - seconds]);
    }
  });

  it("reports the number of deleted rows per table", async () => {
    const { db } = fakeDb({ changes: 12 });
    const results = await runRetention({ DB: db }, NOW);
    expect(results.every((result) => result.deleted === 12)).toBe(true);
    expect(results.every((result) => result.error === undefined)).toBe(true);
    expect(results.every((result) => result.cutoff === NOW - BUCKETS[result.table])).toBe(true);

    const logged = String(logSpy.mock.calls[0][0]);
    expect(JSON.parse(logged).event).toBe("d1_retention");
  });

  it("keeps pruning the other tables when one table fails", async () => {
    const { db, calls } = fakeDb({ failTables: ["visitor_rollups"], changes: 3 });
    const results = await runRetention({ DB: db }, NOW);

    const failed = results.find((result) => result.table === "visitor_rollups");
    expect(failed?.deleted).toBe(0);
    expect(failed?.error).toContain("no such column");
    expect(failed!.error!.length).toBeLessThanOrEqual(140);

    const healthy = results.filter((result) => result.table !== "visitor_rollups");
    expect(healthy).toHaveLength(Object.keys(BUCKETS).length - 1);
    expect(healthy.every((result) => result.deleted === 3 && !result.error)).toBe(true);
    // 失败的表之后仍要继续发 DELETE（不是 break）。
    expect(calls.filter((call) => call.sql.startsWith("DELETE FROM")).length).toBe(
      Object.keys(BUCKETS).length,
    );
  });

  it("defaults the cutoff to the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    try {
      const { db, calls } = fakeDb({ changes: 0 });
      await runRetention({ DB: db });
      const call = calls.find((entry) => entry.sql.startsWith("DELETE FROM events "));
      expect(call!.values).toEqual([NOW - BUCKETS.events]);
    } finally {
      vi.useRealTimers();
    }
  });
});
