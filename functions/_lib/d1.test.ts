/**
 * functions/_lib/d1.ts 的写封装语义（docs/22 W9-7）。
 *
 * 回归：`execute()` 只看 `res.success === true`，忽略 `meta.changes`。
 * D1 的 `run()` 对「0 行受影响」的 UPDATE/DELETE 依然返回 `success: true`，
 * 于是
 *   - `PUT /api/apple-account/accounts/<不存在的 id>` 带新密码时返回 200 ok，
 *     密码被静默丢弃；
 *   - `revokeAuthSession` 对不存在的 sid 回答「已撤销」。
 * 现在：`meta.changes` 明确为 0 时算失败；拿不到 `meta` 时（旧驱动/桩）
 * 保持兼容，按成功处理。
 */

import { describe, expect, it, vi } from "vitest";
import { execute, executeBatch, queryAll, type D1Database } from "./d1";

function dbWithRun(run: (sql: string) => unknown): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const stmt = {
        bind: (..._values: unknown[]) => stmt,
        first: async () => null,
        all: async () => ({ results: [], success: true }),
        run: async () => run(sql),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, sqls };
}

describe("execute", () => {
  it("returns true when the statement changed rows", async () => {
    const { db } = dbWithRun(() => ({ success: true, meta: { changes: 1 } }));
    expect(await execute(db, "UPDATE t SET x = 1 WHERE id = 1")).toBe(true);
  });

  it("returns false when the statement affected zero rows", async () => {
    const { db } = dbWithRun(() => ({ success: true, meta: { changes: 0 } }));
    expect(
      await execute(
        db,
        "UPDATE apple_accounts SET password = ? WHERE id = ?",
        "enc",
        999,
      ),
    ).toBe(false);
  });

  it("passes bound values through and still reports zero changes as false", async () => {
    const seen: unknown[][] = [];
    const db = {
      prepare() {
        const stmt = {
          bind: (...values: unknown[]) => {
            seen.push(values);
            return stmt;
          },
          first: async () => null,
          all: async () => ({ results: [], success: true }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
        return stmt;
      },
    } as unknown as D1Database;
    expect(await execute(db, "DELETE FROM t WHERE id = ?", 7)).toBe(false);
    expect(seen).toEqual([[7]]);
  });

  it("keeps working when the driver reports no meta at all", async () => {
    // 兼容：mock/旧驱动不给 meta 时不能把成功的写判成失败。
    const { db } = dbWithRun(() => ({ success: true }));
    expect(await execute(db, "INSERT INTO t (x) VALUES (1)")).toBe(true);
  });

  it("returns false on success:false and on throw", async () => {
    const failed = dbWithRun(() => ({ success: false, meta: { changes: 0 } }));
    expect(await execute(failed.db, "UPDATE t SET x = 1")).toBe(false);

    const throwing = dbWithRun(() => {
      throw new Error("D1_ERROR: quota exceeded");
    });
    await expect(execute(throwing.db, "UPDATE t SET x = 1")).rejects.toThrow(/quota/);
  });

  it("returns false without a database binding", async () => {
    expect(await execute(undefined, "UPDATE t SET x = 1")).toBe(false);
  });
});

describe("queryAll / executeBatch", () => {
  it("queryAll returns the results array and tolerates a missing db", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ id: 1 }], success: true }),
        }),
        all: async () => ({ results: [{ id: 1 }], success: true }),
      }),
    } as unknown as D1Database;
    expect(await queryAll<{ id: number }>(db, "SELECT id FROM t")).toEqual([{ id: 1 }]);
    expect(await queryAll<{ id: number }>(undefined, "SELECT id FROM t")).toEqual([]);
  });

  it("executeBatch requires every statement to succeed and a full-length result", async () => {
    const stmt = { bind: vi.fn() } as never;
    const ok = {
      batch: async (statements: unknown[]) => statements.map(() => ({ success: true })),
    } as unknown as D1Database;
    expect(await executeBatch(ok, [stmt, stmt])).toBe(true);

    const partial = {
      batch: async () => [{ success: true }, { success: false }],
    } as unknown as D1Database;
    expect(await executeBatch(partial, [stmt, stmt])).toBe(false);

    const short = {
      batch: async () => [{ success: true }],
    } as unknown as D1Database;
    expect(await executeBatch(short, [stmt, stmt])).toBe(false);

    const noBatch = {} as unknown as D1Database;
    expect(await executeBatch(noBatch, [stmt])).toBe(false);
    expect(await executeBatch(ok, [])).toBe(false);
  });
});
