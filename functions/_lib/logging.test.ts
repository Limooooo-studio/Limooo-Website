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

/** 日志隐私纯函数测试：独立观测密钥 + 敏感文本脱敏，不访问 D1/网络。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { ipHash, logEvent, sanitizeLogMessage } from "./logging";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging privacy", () => {
  it("uses only OBSERVABILITY_HMAC_KEY and fails closed when it is missing", async () => {
    const obs = await ipHash("8.8.8.8", { OBSERVABILITY_HMAC_KEY: "obs" } as Env);
    const gate = await ipHash("8.8.8.8", {
      GATE_HMAC_KEY: "gate",
      OBSERVABILITY_HMAC_KEY: "obs",
    } as Env);
    expect(obs).toBe(gate);
    expect(obs).toMatch(/^[0-9a-f]{16}$/);
    expect(await ipHash("8.8.8.8", { GATE_HMAC_KEY: "gate" } as Env)).toBe("");
  });

  it("hashes the connecting IP, never a client-supplied X-Limooo-Client-IP", async () => {
    const env = { OBSERVABILITY_HMAC_KEY: "obs" } as unknown as Env;
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const request = new Request("https://limooo.cn/", {
      headers: {
        "CF-Connecting-IP": "43.108.57.161",
        "X-Limooo-Client-IP": "1.2.3.4",
        "X-Limooo-Client-Country": "CN",
      },
    });

    await logEvent(env, "gate_entry", request, {});

    const payload = JSON.parse(String(spy.mock.calls[0][0])) as { ip_hash: string };
    expect(payload.ip_hash).toBe(await ipHash("43.108.57.161", env));
    expect(payload.ip_hash).not.toBe(await ipHash("1.2.3.4", env));
  });

  it("redacts passwords, bearer tokens, cookies and query strings", () => {
    const clean = sanitizeLogMessage(
      'login password=seekrit&token=abc123 | Bearer abc.def | Cookie: __gate=xyz | /api/a?q=secret',
    );
    expect(clean).not.toContain("seekrit");
    expect(clean).not.toContain("abc.def");
    expect(clean).not.toContain("__gate=xyz");
    expect(clean).not.toContain("q=secret");
    expect(clean).toContain("[redacted]");
  });
});

/**
 * W9-19：D1 故障时不能每个请求都先跑一遍建表语句。
 *
 * 成功才置位 ready 时，配额耗尽/绑定失效期间**每个**请求都要先打一批必然失败的
 * DDL，把一次故障放大成 N 次。改成「记住已尝试 + 每分钟最多重试一次」，
 * 并把多条 DDL 压成一个 db.batch 往返。
 */
describe("event schema bootstrap", () => {
  /** 记录 prepare/batch 的最小 D1 桩。 */
  function fakeDb(options: { batch?: boolean; fail?: boolean } = {}) {
    const preparedSql: string[] = [];
    const batches: string[][] = [];
    const db: Record<string, unknown> = {
      prepare(sql: string) {
        preparedSql.push(sql);
        // 真实 D1PreparedStatement 能读到 SQL；桩也带上，才能断言 batch 里装的是
        // 真正的建表语句（而不是空串）。
        const stmt = {
          sql,
          bind: (..._values: unknown[]) => stmt,
          first: async () => null,
          all: async () => ({ results: [], success: true }),
          run: async () => {
            if (options.fail) throw new Error("D1_ERROR: quota exceeded");
            return { success: true, meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    if (options.batch !== false) {
      db.batch = async (statements: Array<{ sql?: string }>) => {
        const sqls = statements.map((s) => String((s as { sql?: string }).sql ?? ""));
        batches.push(sqls);
        if (options.fail) throw new Error("D1_ERROR: quota exceeded");
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      };
    }
    return { db: db as never, preparedSql, batches };
  }

  it("attempts the DDL once for many events while D1 keeps failing", async () => {
    vi.resetModules();
    const mod = await import("./logging");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { db, preparedSql, batches } = fakeDb({ fail: true });
    const env = { DB: db, OBSERVABILITY_HMAC_KEY: "obs" } as unknown as Env;
    const request = new Request("https://limooo.cn/");

    for (let i = 0; i < 5; i++) await mod.logEvent(env, "gate_entry", request, {});
    consoleSpy.mockRestore();

    // 5 个请求只换来一次 DDL 尝试（一次 batch 往返 = 全部建表语句）。
    expect(batches).toHaveLength(1);
    expect(batches[0].length).toBeGreaterThanOrEqual(4);
    // 而且 DDL 只 prepare、不逐句 run：preparedSql 里除了 DDL 只剩那条必然失败的
    // INSERT，没有任何逐句执行建表的痕迹（否则等于把 13 次往返又打了一遍）。
    const preparedDdl = preparedSql.filter((sql) => sql.startsWith("CREATE TABLE"));
    expect(preparedDdl).toHaveLength(1);
  });

  it("does not run the DDL again once it has succeeded", async () => {
    vi.resetModules();
    const mod = await import("./logging");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { db, batches } = fakeDb();
    const env = { DB: db } as unknown as Env;
    const request = new Request("https://limooo.cn/");

    for (let i = 0; i < 3; i++) await mod.logEvent(env, "gate_entry", request, {});
    consoleSpy.mockRestore();
    expect(batches).toHaveLength(1);
  });

  it("retries the DDL once the cooldown has elapsed", async () => {
    vi.resetModules();
    const mod = await import("./logging");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { db, batches } = fakeDb({ fail: true });
    const env = { DB: db } as unknown as Env;
    const request = new Request("https://limooo.cn/");

    await mod.logEvent(env, "gate_entry", request, {});
    expect(batches).toHaveLength(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await mod.logEvent(env, "gate_entry", request, {});
    vi.useRealTimers();
    consoleSpy.mockRestore();

    expect(batches).toHaveLength(2);
  });

  it("falls back to per-statement DDL only when batch is unavailable", async () => {
    vi.resetModules();
    const mod = await import("./logging");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { db, preparedSql, batches } = fakeDb({ batch: false, fail: true });
    const env = { DB: db } as unknown as Env;
    const request = new Request("https://limooo.cn/");

    await mod.logEvent(env, "gate_entry", request, {});
    consoleSpy.mockRestore();

    expect(batches).toHaveLength(0);
    expect(preparedSql.filter((sql) => sql.startsWith("CREATE TABLE")).length).toBeGreaterThan(0);
  });
});
