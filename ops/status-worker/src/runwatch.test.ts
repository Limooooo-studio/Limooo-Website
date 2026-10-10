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
 * 每日检查 · 步骤 1：`worker_runs` 最近一次运行是否成功（runwatch.ts + index.ts）。
 *
 * 迁移 018 让两个 cron Worker 把失败写进表里，但**没有读者**——这批用例钉住
 * 「有读者了、而且读者不会把每日任务带倒」：
 *   - failed / 卡死的 running 必须告警，且文案指得出是哪个 job；
 *   - ok / skipped / 刚开始跑的 running 不告警（否则每天一条噪音）；
 *   - 表不存在或查询抛错：只记日志，**不抛**，每日任务里的保留清理照跑；
 *   - 这张表每天**只读一次**（spy 计数），查询形状是「每 job 一次索引 seek」，
 *     不是 GROUP BY 全索引扫（成本证据见 runwatch.ts 文件头）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  ALERT_I18N,
  ALERT_KINDS,
  buildCheckAlertEmail,
  checkWorkerRuns,
  esc,
  runDailyChecks,
  type Env,
} from "./index";
import { STALE_RUNNING_S, WATCHED_JOBS, errorSummary, formatUtc, runIssues } from "./runwatch";

const NOW = 1_800_000_000; // 固定时钟：2027-01-15 08:00:00 UTC

interface Call {
  sql: string;
  values: unknown[];
}

/** 与 LatestRun 同形；用 type（而非 interface）以便赋给 Record<string, unknown>。 */
type LatestRunRow = {
  job: string;
  outcome: string;
  started_at: number;
  error: string | null;
};

/**
 * 记录每一次 prepare（含 bind 值）的 D1 桩。
 *
 * `failOn` 用来模拟「迁移 018 没应用」：SQLite 在 prepare 那一步就会报
 * `no such table`（真实 D1 一样），于是 readLatestRuns 的 try/catch 生效。
 */
function fakeDb(
  options: { latest?: LatestRunRow[]; failOn?: (sql: string) => boolean } = {},
) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      calls.push({ sql, values: [] });
      if (options.failOn?.(sql)) {
        throw new Error("D1_ERROR: no such table: worker_runs");
      }
      const finish = () => ({
        all: async () =>
          /FROM worker_runs/i.test(sql) ? { results: options.latest ?? [] } : { results: [] },
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
      });
      return {
        bind: (...values: unknown[]) => {
          calls[calls.length - 1] = { sql, values };
          return finish();
        },
        ...finish(),
      };
    },
    batch: async () => [],
  };
  const workerRunsQueries = () =>
    calls.filter((c) => /worker_runs/i.test(c.sql)).length;
  return { db: db as unknown as D1Database, calls, workerRunsQueries };
}

/** 告警通道：Email binding + 收件人，捕获发出的信（不碰网络）。 */
function alertEnv(db: D1Database, extra: Partial<Env> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const env = {
    DB: db,
    ALERT_TO: "ops@example.com",
    ALERT_LANG: "zh-cn",
    EMAIL: { send: async (m: unknown) => void sent.push(m as Record<string, unknown>) },
    ...extra,
  } as unknown as Env;
  return { env, sent };
}

function run(
  job: string,
  outcome: string,
  startedAt: number,
  error: string | null = null,
): LatestRunRow {
  return { job, outcome, started_at: startedAt, error };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker_runs → alert (daily check step 1)", () => {
  it("alerts on outcome=failed and names the job in the copy", async () => {
    const { db, workerRunsQueries } = fakeDb({
      latest: [
        run("blocklist_sync", "failed", NOW - 600, "CF API 500 https://api.cloudflare.com/..."),
        run("d1_archive", "ok", NOW - 3600),
      ],
    });
    const { env, sent } = alertEnv(db);

    const step = await checkWorkerRuns(env, NOW);

    expect(step).toEqual({ ok: true, issues: 1, alerted: true });
    expect(sent).toHaveLength(1);
    expect(String(sent[0].subject)).toContain("blocklist_sync");
    expect(String(sent[0].text)).toContain("outcome=failed");
    expect(String(sent[0].text)).toContain("CF API 500");
    // 「哪个 job、什么时候、什么 outcome、error 摘要」四件事都要在正文里。
    expect(String(sent[0].text)).toContain(formatUtc(NOW - 600));
    // 同一次每日检查只读一次这张表。
    expect(workerRunsQueries()).toBe(1);
  });

  it("stays quiet when every job is ok or skipped", async () => {
    const { db } = fakeDb({
      latest: [
        run("blocklist_sync", "ok", NOW - 600),
        run("d1_archive", "skipped", NOW - 3600, "missing credentials"),
      ],
    });
    const { env, sent } = alertEnv(db);

    const step = await checkWorkerRuns(env, NOW);

    expect(step).toEqual({ ok: true, issues: 0, alerted: false });
    expect(sent).toHaveLength(0);
  });

  it("alerts on a run stuck in 'running' past the threshold, but not on a fresh one", async () => {
    const staleDb = fakeDb({ latest: [run("d1_archive", "running", NOW - STALE_RUNNING_S - 60)] });
    const freshDb = fakeDb({ latest: [run("d1_archive", "running", NOW - 30)] });
    const stale = alertEnv(staleDb.db);
    const fresh = alertEnv(freshDb.db);

    const staleStep = await checkWorkerRuns(stale.env, NOW);
    const freshStep = await checkWorkerRuns(fresh.env, NOW);

    expect(staleStep).toEqual({ ok: true, issues: 1, alerted: true });
    expect(freshStep).toEqual({ ok: true, issues: 0, alerted: false });
    expect(stale.sent).toHaveLength(1);
    expect(String(stale.sent[0].text)).toContain("running");
    expect(fresh.sent).toHaveLength(0);
  });

  it("does not alert when a watched job has no row at all (never ran ≠ failed)", async () => {
    const { db } = fakeDb({ latest: [run("blocklist_sync", "ok", NOW - 600)] });
    const { env, sent } = alertEnv(db);

    const step = await checkWorkerRuns(env, NOW);

    expect(step.issues).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("fails open (no alert, no throw) when the table does not exist", async () => {
    const { db } = fakeDb({ failOn: (sql) => /worker_runs/i.test(sql) });
    const { env, sent } = alertEnv(db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const step = await checkWorkerRuns(env, NOW);

    expect(step.ok).toBe(false);
    expect(step.issues).toBe(0);
    expect(step.alerted).toBe(false);
    expect(step.reason).toContain("no such table");
    expect(sent).toHaveLength(0);
    expect(errors).toHaveBeenCalled();
  });

  it("sends one aggregated alert when several jobs are broken", async () => {
    const { db } = fakeDb({
      latest: [
        run("blocklist_sync", "failed", NOW - 600, "boom"),
        run("d1_archive", "failed", NOW - 3600, "kaboom"),
      ],
    });
    const { env, sent } = alertEnv(db);

    const step = await checkWorkerRuns(env, NOW);

    expect(step.issues).toBe(2);
    expect(sent).toHaveLength(1);
    const text = String(sent[0].text);
    expect(text).toContain("blocklist_sync");
    expect(text).toContain("d1_archive");
  });

  it("sends nothing when no alert channel is configured (still logs the failure)", async () => {
    const { db } = fakeDb({ latest: [run("d1_archive", "failed", NOW - 60, "boom")] });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    const step = await checkWorkerRuns({ DB: db } as Env, NOW);

    // 没有通道 ≠ 没有发现问题：issues 仍要如实报出来（便于日志/接口排查）。
    expect(step).toEqual({ ok: true, issues: 1, alerted: false });
    expect(logs.mock.calls.flat().join(" ")).toContain("worker_runs_alert_skipped");
  });
});

describe("runwatch SQL shape (cost discipline)", () => {
  it("reads the latest row per job with an index-friendly seek, never a GROUP BY scan", async () => {
    const { db, calls } = fakeDb({ latest: [] });
    await checkWorkerRuns(alertEnv(db).env, NOW);

    const queries = calls.filter((c) => /worker_runs/i.test(c.sql));
    expect(queries).toHaveLength(1);
    const sql = queries[0].sql;
    // 每 job 一个 `WHERE job = ? ORDER BY started_at DESC LIMIT 1`（走
    // idx_worker_runs_job_started），拼成一条语句、一次往返。
    expect(sql.match(/ORDER BY started_at DESC LIMIT 1/g)).toHaveLength(WATCHED_JOBS.length);
    expect(sql).not.toMatch(/GROUP BY/i);
    expect(sql).not.toMatch(/COUNT\s*\(/i);
    expect(sql).not.toMatch(/JOIN/i);
    // 只列需要的列，不用 SELECT *（以后加列也不会无意中把大字段读出来）。
    expect(sql).toContain("SELECT job, outcome, started_at, error");
    // 只读这张表本身，不带出别的表。
    expect(sql.match(/FROM worker_runs/g)).toHaveLength(WATCHED_JOBS.length);
  });

  it("binds every watched job as a parameter, in order", async () => {
    const { db, calls } = fakeDb({ latest: [] });
    await checkWorkerRuns(alertEnv(db).env, NOW);
    const [query] = calls.filter((c) => /worker_runs/i.test(c.sql));
    expect(query.values).toEqual([...WATCHED_JOBS]);
  });
});

describe("runwatch pure helpers", () => {
  it("classifies outcomes", () => {
    expect(runIssues([run("a", "ok", 0)], NOW)).toHaveLength(0);
    expect(runIssues([run("a", "skipped", 0)], NOW)).toHaveLength(0);
    expect(runIssues([run("a", "failed", NOW)], NOW)).toHaveLength(1);
    // 未知 outcome 也要报：新的取值不该悄悄变成「没人看」。
    expect(runIssues([run("a", "cancelled", NOW)], NOW)).toHaveLength(1);
    // running 的阈值边界：正好 2 小时算异常，差一秒不算。
    expect(runIssues([run("a", "running", NOW - STALE_RUNNING_S)], NOW)).toHaveLength(1);
    expect(runIssues([run("a", "running", NOW - STALE_RUNNING_S + 1)], NOW)).toHaveLength(0);
  });

  it("summarises errors instead of dumping stacks", () => {
    expect(errorSummary(null)).toBe("-");
    expect(errorSummary("a\n  b\tc")).toBe("a b c");
    const long = errorSummary("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith("…")).toBe(true);
  });

  it("formats timestamps as UTC and keeps '-' for junk", () => {
    expect(formatUtc(1_700_000_000)).toBe("2023-11-14 22:13:20 UTC");
    expect(formatUtc(0)).toBe("-");
    expect(formatUtc(Number.NaN)).toBe("-");
  });
});

describe("alert copy for the daily checks", () => {
  it("has every kind in all four languages", () => {
    for (const lang of ["zh-cn", "en-us", "ja-jp", "ko-kr"]) {
      const table = ALERT_I18N[lang];
      expect(table, lang).toBeTruthy();
      for (const kind of ALERT_KINDS) {
        for (const key of [`subject_${kind}`, `title_${kind}`, `intro_${kind}`]) {
          expect(table[key], `${lang}.${key}`).toBeTruthy();
        }
      }
      expect(table.view, `${lang}.view`).toBeTruthy();
      expect(table.hint, `${lang}.hint`).toBeTruthy();
    }
  });

  it("renders one row per finding and escapes it", () => {
    const mail = buildCheckAlertEmail(
      "en-us",
      "runs",
      [{ name: "blocklist_sync", detail: "<script>alert(1)</script>" }],
      NOW,
    );
    expect(mail.subject).toContain("blocklist_sync");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain(esc("blocklist_sync"));
    expect(mail.text).toContain(formatUtc(NOW));
  });

  it("falls back to zh-cn for an unknown language", () => {
    const mail = buildCheckAlertEmail("de-de", "blocklist", [{ name: "L", detail: "d" }], NOW);
    expect(mail.subject).toContain(ALERT_I18N["zh-cn"].subject_blocklist);
  });

  it("keeps the subject short even with a huge error summary", () => {
    const mail = buildCheckAlertEmail(
      "zh-cn",
      "runs",
      [{ name: "j".repeat(500), detail: "d" }],
      NOW,
    );
    expect(mail.subject.length).toBeLessThanOrEqual(120);
  });
});

describe("daily cron wiring", () => {
  const scheduled = (cron: string, env: Env) =>
    worker.scheduled({ cron } as ScheduledController, env);

  it("runs retention first and then the checks on 47 3 * * *", async () => {
    const { db, calls } = fakeDb({ latest: [run("blocklist_sync", "failed", NOW - 60, "boom")] });
    const { env, sent } = alertEnv(db);

    await scheduled("47 3 * * *", env);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /DELETE FROM heartbeats/i.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM worker_runs/i.test(s))).toBe(true);
    // 保留清理先跑：即便这条 cleanup 顺序换了，也应当是 DELETE 出现在前面。
    expect(sqls.findIndex((s) => /DELETE FROM/i.test(s))).toBeLessThan(
      sqls.findIndex((s) => /FROM worker_runs/i.test(s)),
    );
    expect(sent).toHaveLength(1);
  });

  it("keeps running retention when worker_runs is unreadable (fail-open)", async () => {
    const { db, calls } = fakeDb({ failOn: (sql) => /worker_runs/i.test(sql) });
    const { env, sent } = alertEnv(db);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(scheduled("47 3 * * *", env)).resolves.toBeUndefined();

    expect(calls.some((c) => /DELETE FROM heartbeats/i.test(c.sql))).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("does not touch worker_runs on the every-minute probe cron", async () => {
    const { db, calls } = fakeDb({ latest: [run("blocklist_sync", "failed", NOW - 60, "boom")] });
    const { env, sent } = alertEnv(db);

    await scheduled("* * * * *", env);

    expect(calls.some((c) => /worker_runs/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /DELETE FROM/i.test(c.sql))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("exposes the daily checks through an ops endpoint, behind the token", async () => {
    const { db, calls } = fakeDb({ latest: [run("d1_archive", "ok", NOW - 60)] });
    const { env } = alertEnv(db, { STATUS_TOKEN: "tok-0123456789" } as Partial<Env>);

    const unauth = await worker.fetch(
      new Request("https://status.limooo.cn/daily-checks", { method: "POST" }),
      env,
    );
    expect(unauth.status).toBe(401);
    expect(calls).toHaveLength(0);

    const ok = await worker.fetch(
      new Request("https://status.limooo.cn/daily-checks", {
        method: "POST",
        headers: { Authorization: "Bearer tok-0123456789" },
      }),
      env,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { runs: { ok: boolean }; blocklist: { ok: boolean } };
    expect(body.runs).toEqual({ ok: true, issues: 0, alerted: false });
    // 没配 Cloudflare 凭据 → 这一步 fail-open（只记日志，不报警）。
    expect(body.blocklist.ok).toBe(false);
  });

  it("runs both checks from runDailyChecks and reports each step separately", async () => {
    const { db } = fakeDb({ latest: [run("blocklist_sync", "ok", NOW - 60)] });
    const { env } = alertEnv(db);

    const result = await runDailyChecks(env, NOW);

    expect(result.runs.ok).toBe(true);
    expect(result.blocklist.ok).toBe(false);
    expect(result.blocklist.reason).toBe("missing_credentials");
  });
});
