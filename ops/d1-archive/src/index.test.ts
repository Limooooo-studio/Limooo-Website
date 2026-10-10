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

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { archivePreviousDay, runArchive } from "./index";

const scheduled = worker.scheduled;

/** 记下每一次 SQL 与绑定值，好断言「运行记录确实写了、写的是哪个 job」。 */
interface SqlCall {
  sql: string;
  values: unknown[];
}

/**
 * 归档用的 D1 桩：分析表返回 1 行，worker_runs 的 INSERT/UPDATE/SELECT 走内存。
 *
 * `failSql` 命中的语句直接抛错，用来模拟「某张归档表读不了」这类真实失败；
 * 构造函数里 guard() 是**同步抛出**的，所以 async 调用点会变成 rejection。
 */
function d1Stub(options: { failSql?: RegExp } = {}) {
  const calls: SqlCall[] = [];
  let nextId = 1;
  let latest: Record<string, unknown> | undefined;
  const prepare = (sql: string) => {
    const call: SqlCall = { sql, values: [] };
    calls.push(call);
    const guard = () => {
      if (options.failSql?.test(sql)) throw new Error("D1 read failed (simulated)");
    };
    const rows = async () => {
      guard();
      if (/FROM worker_runs/.test(sql)) return { results: latest ? [{ ...latest }] : [], success: true };
      return { results: [{ id: 1, status: 302 }], success: true };
    };
    return {
      all: rows,
      bind(...values: unknown[]) {
        call.values = values;
        return {
          all: async () => {
            guard();
            if (/INSERT INTO worker_runs/.test(sql)) return { results: [{ id: nextId++ }], success: true };
            if (/FROM worker_runs/.test(sql)) return { results: latest ? [{ ...latest }] : [], success: true };
            return { results: [{ id: 1, status: 302 }], success: true };
          },
          run: async () => {
            guard();
            if (/UPDATE worker_runs/.test(sql)) {
              const [finished_at, outcome, added, removed, error, id] = call.values;
              latest = { id, job: "d1_archive", finished_at, outcome, added, removed, error };
            }
            return { success: true };
          },
        };
      },
    };
  };
  return { db: { prepare }, calls };
}

function env(stub = d1Stub()) {
  const put = vi.fn().mockResolvedValue({ key: "ok" });
  return {
    env: {
      DB: stub.db,
      ARCHIVE: { put },
      SYNC_TOKEN: "s3cret-token",
    },
    put,
    stub,
  };
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return { logs, errors };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("d1 archive", () => {
  it("archives the previous UTC day to one gzip object per table", async () => {
    const f = env();
    const counts = await archivePreviousDay(f.env as never, new Date("2026-09-09T00:00:00Z"));
    expect(counts).toEqual({
      visitor_rollups: 1,
      visitors_v2: 1,
      ray_log_v2: 1,
      events: 1,
    });
    expect(f.put).toHaveBeenCalledTimes(4);
    expect(f.put.mock.calls[0][0]).toBe("analytics/2026_09_08/visitor_rollups.jsonl.gz");
    expect(f.put.mock.calls[0][2]).toEqual({
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    });
  });

  it("writes one worker_runs row with job=d1_archive and outcome=ok", async () => {
    const f = env();
    captureConsole();

    const { counts, runId } = await runArchive(f.env as never, new Date("2026-09-09T00:00:00Z"));

    expect(counts.events).toBe(1);
    expect(runId).toBe(1);
    const insert = f.stub.calls.find((c) => /INSERT INTO worker_runs/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.values).toEqual(["d1_archive", expect.any(Number)]);
    const update = f.stub.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update!.values[1]).toBe("ok");
    expect(update!.values[2]).toBe(4);
  });

  it("records a failed run and keeps the error text when archiving throws", async () => {
    // ray_log_v2 读不了：失败点落在归档中途，跟线上最像。
    const f = env(d1Stub({ failSql: /FROM ray_log_v2/ }));
    const { errors } = captureConsole();

    await expect(runArchive(f.env as never, new Date("2026-09-09T00:00:00Z"))).rejects.toThrow(
      /simulated/,
    );

    const update = f.stub.calls.find((c) => /UPDATE worker_runs/.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.values[1]).toBe("failed");
    expect(String(update!.values[4])).toMatch(/simulated/);
    // 失败必须同时落进 Workers 日志，且是单行可检索 JSON。
    const failedLine = errors.find((l) => l.includes('"outcome":"failed"'));
    expect(failedLine).toBeDefined();
    const parsed = JSON.parse(failedLine!);
    expect(parsed.event).toBe("d1_archive");
    expect(parsed.job).toBe("d1_archive");
    expect(parsed.error).toMatch(/simulated/);
  });

  it("fails open when the run record cannot be written", async () => {
    const { errors } = captureConsole();
    const brokenDb = {
      prepare(sql: string) {
        const boom = async () => {
          if (/worker_runs/.test(sql)) throw new Error("no such table: worker_runs");
          return { results: [{ id: 1, status: 302 }], success: true };
        };
        return {
          all: boom,
          bind: () => ({
            all: boom,
            run: async () => {
              throw new Error("no such table: worker_runs");
            },
          }),
        };
      },
    };
    const put = vi.fn().mockResolvedValue({ key: "ok" });
    const brokenEnv = { DB: brokenDb, ARCHIVE: { put }, SYNC_TOKEN: "s3cret-token" };

    // 记账失败绝不能把归档本身带崩，R2 依旧写满四个对象。
    const { counts, runId } = await runArchive(brokenEnv as never, new Date("2026-09-09T00:00:00Z"));
    expect(runId).toBeNull();
    expect(counts).toEqual({ visitor_rollups: 1, visitors_v2: 1, ray_log_v2: 1, events: 1 });
    expect(put).toHaveBeenCalledTimes(4);
    expect(errors.some((l) => l.includes("worker_run_store_error"))).toBe(true);
  });

  it("the scheduled handler records and logs a failure instead of swallowing it", async () => {
    const f = env(d1Stub({ failSql: /FROM events/ }));
    const { errors } = captureConsole();
    const waited: Promise<unknown>[] = [];

    await scheduled({}, f.env as never, { waitUntil: (p) => waited.push(p) });

    expect(
      f.stub.calls.some((c) => /UPDATE worker_runs/.test(c.sql) && c.values[1] === "failed"),
    ).toBe(true);
    expect(errors.some((l) => l.includes('"outcome":"failed"'))).toBe(true);
    expect(waited).toHaveLength(1);
    // scheduled 自己的收口行必须带 stage="scheduled" —— 否则把 catch 退回成
    // 「静默吞掉」时，runArchive 那行日志照样还在，用例就抓不到这个退化。
    const scheduledLine = errors
      .map((l) => JSON.parse(l))
      .find((line) => line.stage === "scheduled");
    expect(scheduledLine).toMatchObject({ event: "d1_archive", job: "d1_archive", outcome: "failed" });
    expect(scheduledLine.error).toMatch(/simulated/);
  });
});

describe("d1 archive health endpoint", () => {
  const healthReq = (auth?: string) =>
    new Request("https://limooo-d1-archive.limooo.workers.dev/?health=1", {
      headers: auth ? { Authorization: auth } : {},
    });

  it("rejects unauthenticated callers with 401", async () => {
    const f = env();
    const resp = await worker.fetch(healthReq(), f.env as never);
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("fails closed when SYNC_TOKEN is not configured", async () => {
    const f = env();
    const noSecret = { ...f.env, SYNC_TOKEN: "" };
    const resp = await worker.fetch(healthReq("Bearer anything"), noSecret as never);
    expect(resp.status).toBe(401);
  });

  it("returns ok + lastRun for an authorized caller without archiving", async () => {
    const f = env();
    captureConsole();
    await runArchive(f.env as never, new Date("2026-09-09T00:00:00Z"));
    f.put.mockClear();

    const resp = await worker.fetch(healthReq("Bearer s3cret-token"), f.env as never);

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.job).toBe("d1_archive");
    expect(body.lastRun).toMatchObject({ job: "d1_archive", outcome: "ok" });
    // 健康端点只报告，绝不触发归档（不写 R2）。
    expect(f.put).not.toHaveBeenCalled();
  });
});
