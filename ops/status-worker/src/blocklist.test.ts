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
 * 每日检查 · 步骤 2：Cloudflare IP List == D1 `blocked_ips` (active=1)。
 *
 * 这条不变量此前只有手工入口（`ops/check_blocklist_sync.py`，实测被自动化调用
 * 0 处）：同步部分失败或有人在 Dashboard 手改 List，边缘就不封了，而 D1 侧
 * 看起来一切正常。这批用例钉住自动化版本的行为：
 *   - 一致 → **不**告警（每天一条「一切正常」是噪音）；
 *   - to_add / to_remove 任一非 0 → 告警，且文案带得上数字与差异条目；
 *   - 凭据缺失 / D1 读失败 / API 失败 → fail-open：只记日志、不报警、不抛；
 *   - 每天只读一次 D1、只调有限的两次只读 API（spy 计数）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { checkBlocklistRuns, runDailyChecks, type Env } from "./index";
import { LIST_NAME, MAX_ITEM_PAGES, diffBlocklist, normalizeListItem } from "./blocklist";

const NOW = 1_800_000_000;

interface Call {
  sql: string;
  values: unknown[];
}

/** 只回答 blocked_ips 的 D1 桩；记录 SQL 以便断言「每天只读一次」。 */
function fakeDb(options: { active?: string[]; failOn?: (sql: string) => boolean } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      calls.push({ sql, values: [] });
      if (options.failOn?.(sql)) throw new Error("D1_ERROR: no such table: blocked_ips");
      const finish = () => ({
        all: async () =>
          /FROM blocked_ips/i.test(sql)
            ? { results: (options.active ?? []).map((cidr) => ({ cidr })) }
            : { results: [] },
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
  return { db: db as unknown as D1Database, calls };
}

/** Cloudflare 只读 API 的桩：按 URL 分派，500 用 `"fail"` 表示。 */
function cfFetch(routes: { lists: unknown; items?: unknown }) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (/\/rules\/lists(\?|$)/.test(url)) {
      if (routes.lists === "fail") return new Response("nope", { status: 500 });
      return Response.json(routes.lists);
    }
    if (/\/items/.test(url)) {
      if (routes.items === "fail") return new Response("nope", { status: 500 });
      return Response.json(routes.items ?? { result: [], result_info: {} });
    }
    return new Response("unexpected", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { urls, fn };
}

const listsWith = (items: string[]) => ({
  result: [{ id: "list-1", name: LIST_NAME }],
  result_info: {},
});
const itemsWith = (ips: string[]) => ({
  result: ips.map((ip, i) => ({ ip, id: `item-${i}` })),
  result_info: {},
});

function checkEnv(db: D1Database, extra: Partial<Env> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const env = {
    DB: db,
    ALERT_TO: "ops@example.com",
    ALERT_LANG: "zh-cn",
    EMAIL: { send: async (m: unknown) => void sent.push(m as Record<string, unknown>) },
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct-id",
    ...extra,
  } as unknown as Env;
  return { env, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("blocklist invariant (daily check step 2)", () => {
  it("stays quiet when both sides agree", async () => {
    const { db, calls } = fakeDb({ active: ["58.222.33.0/24"] });
    cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24"]) });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step).toEqual({ ok: true, issues: 0, alerted: false });
    expect(sent).toHaveLength(0);
    // 一致时也只读一次 D1（不额外做校验查询）。
    expect(calls.filter((c) => /blocked_ips/i.test(c.sql))).toHaveLength(1);
  });

  it("treats an IPv4 /32 and its bare form as the same entry", async () => {
    // Cloudflare 会把 /32 归一化成裸 IP（写 203.0.113.7/32、读回 203.0.113.7）。
    // 不归一化就会出现「同一条既该加又该删」，每天一条假告警。
    const { db } = fakeDb({ active: ["58.222.33.0/24", "203.0.113.7/32"] });
    cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24", "203.0.113.7"]) });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step.issues).toBe(0);
    expect(sent).toHaveLength(0);
    expect(diffBlocklist(["203.0.113.7/32"], ["203.0.113.7"])).toEqual({
      toAdd: [],
      toRemove: [],
    });
  });

  it("alerts with numbers when D1 has an entry the IP List is missing (to_add)", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24", "203.0.113.7"] });
    cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24"]) });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step).toEqual({ ok: true, issues: 1, alerted: true });
    expect(sent).toHaveLength(1);
    const text = String(sent[0].text);
    expect(text).toContain("desired=2 actual=1 to_add=1 to_remove=0");
    expect(text).toContain("203.0.113.7");
    expect(String(sent[0].subject)).toContain("to_add=1 to_remove=0");
  });

  it("alerts when the IP List has an entry D1 no longer has (to_remove)", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    cfFetch({
      lists: listsWith([]),
      items: itemsWith(["58.222.33.0/24", "198.51.100.0/24"]),
    });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step).toEqual({ ok: true, issues: 1, alerted: true });
    const text = String(sent[0].text);
    expect(text).toContain("desired=1 actual=2 to_add=0 to_remove=1");
    expect(text).toContain("198.51.100.0/24");
  });

  it("reports a missing List as drift instead of silently passing", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    const { urls } = cfFetch({ lists: { result: [], result_info: {} } });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step.issues).toBe(1);
    expect(String(sent[0].text)).toContain(`list ${LIST_NAME} not found`);
    // 找不到 List 就不该去读 items（只读检查也不创建 List）。
    expect(urls.filter((u) => /items/.test(u))).toHaveLength(0);
  });

  it("fails open when the Cloudflare API errors", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    cfFetch({ lists: "fail" });
    const { env, sent } = checkEnv(db);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const step = await checkBlocklistRuns(env);

    expect(step.ok).toBe(false);
    expect(step.alerted).toBe(false);
    expect(step.reason).toContain("cf_error");
    expect(sent).toHaveLength(0);
  });

  it("fails open when the items page errors", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    cfFetch({ lists: listsWith([]), items: "fail" });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("fails open when the D1 read errors", async () => {
    const { db } = fakeDb({ failOn: (sql) => /blocked_ips/i.test(sql) });
    const { urls } = cfFetch({ lists: listsWith([]), items: itemsWith([]) });
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step.ok).toBe(false);
    expect(step.reason).toContain("d1_error");
    expect(sent).toHaveLength(0);
    // D1 读失败就不该再去问 Cloudflare（省一次 API 调用，也不做半个判断）。
    expect(urls).toHaveLength(0);
  });

  it("fails open without touching D1 or the API when credentials are not configured", async () => {
    const { db, calls } = fakeDb({ active: ["58.222.33.0/24"] });
    const { fn } = cfFetch({ lists: listsWith([]) });
    const { env, sent } = checkEnv(db, {
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: undefined,
    });

    const step = await checkBlocklistRuns(env);

    // 「没配 secret」= 没检查，不是失败，更不能报警（别人 clone 后不该收到误报）。
    expect(step).toEqual({ ok: false, issues: 0, alerted: false, reason: "missing_credentials" });
    expect(calls).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("reads D1 once and makes at most two read-only API calls per day", async () => {
    const { db, calls } = fakeDb({ active: ["58.222.33.0/24"] });
    const { urls } = cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24"]) });
    const { env } = checkEnv(db);

    await checkBlocklistRuns(env);

    const d1 = calls.filter((c) => /blocked_ips/i.test(c.sql));
    expect(d1).toHaveLength(1);
    // 唯一允许的形状：只读 active 行，走 idx_blocked_ips_active。
    expect(d1[0].sql).toBe("SELECT cidr FROM blocked_ips WHERE active = 1");
    // 两次只读 API：按名字找 List（拿 id）+ 读一页 items（列表 id 不写死）。
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/rules/lists?per_page=100");
    expect(urls[1]).toContain("/items?per_page=500");
    // 不碰同步 Worker 的写路径。
    expect(urls.some((u) => /bulk_operations|POST/.test(u))).toBe(false);
  });

  it("stops paging instead of looping forever when the cursor does not advance", async () => {
    const { db } = fakeDb({ active: [] });
    let page = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (/\/rules\/lists(\?|$)/.test(url)) return Response.json(listsWith([]));
        page += 1;
        return Response.json({
          result: [{ ip: `10.0.0.${page}`, id: `i${page}` }],
          result_info: { cursor: "same" },
        });
      }),
    );
    const { env, sent } = checkEnv(db);

    const step = await checkBlocklistRuns(env);

    expect(step.ok).toBe(false);
    expect(step.reason).toContain("cursor did not advance");
    expect(sent).toHaveLength(0);
    expect(page).toBeLessThanOrEqual(MAX_ITEM_PAGES);
  });
});

describe("blocklist helpers", () => {
  it("normalises /32 and /128 only", () => {
    expect(normalizeListItem("1.2.3.4/32")).toBe("1.2.3.4");
    expect(normalizeListItem("2001:db8::1/128")).toBe("2001:db8::1");
    expect(normalizeListItem(" 1.2.3.0/24 ")).toBe("1.2.3.0/24");
    expect(normalizeListItem("vpn.example.com")).toBe("vpn.example.com");
    expect(normalizeListItem("")).toBe("");
  });
});

describe("daily cron wiring for the blocklist check", () => {
  const scheduled = (cron: string, env: Env) =>
    worker.scheduled({ cron } as ScheduledController, env);

  it("runs it on the daily cron", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    const { urls } = cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24"]) });
    const { env, sent } = checkEnv(db);

    await scheduled("47 3 * * *", env);

    expect(urls.length).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it("never runs it on the every-minute probe cron", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    const { fn } = cfFetch({ lists: listsWith([]), items: itemsWith([]) });
    const { env } = checkEnv(db);

    await scheduled("* * * * *", env);

    expect(fn).not.toHaveBeenCalled();
  });

  it("is part of runDailyChecks together with the worker_runs step", async () => {
    const { db } = fakeDb({ active: ["58.222.33.0/24"] });
    cfFetch({ lists: listsWith([]), items: itemsWith(["58.222.33.0/24"]) });
    const { env, sent } = checkEnv(db);

    const result = await runDailyChecks(env, NOW);

    expect(result.blocklist).toEqual({ ok: true, issues: 0, alerted: false });
    expect(result.runs.ok).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
