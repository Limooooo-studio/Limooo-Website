/**
 * GET /logout 回跳目标校验（docs/22 W9-3）。
 *
 * 回归：`next` 以前被原样塞进 `Location` 头。Access team domain 为空时
 * `accessTeamDomain(env)` 为假，代码走 `target = next` 分支 —— 任意外站
 * 都能借本站做开放重定向；带 CR/LF 的非法头值还会让 workerd 抛异常变 500。
 * 与 `login.ts` 对齐后只允许站内相对路径或白名单主机的 https 地址。
 */

import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "./logout";
import type { Env } from "./_lib/env";

// 登出会写审计行；这里只关心 Location，D1 不参与断言。
vi.mock("./_lib/logging", () => ({
  logEvent: async () => undefined,
}));

const keys = {
  TURNSTILE_SECRET: "turnstile-secret",
  GATE_HMAC_KEY: "a".repeat(64),
  SESSION_HMAC_KEY: "b".repeat(64),
};

function env(extra: Partial<Env> = {}): Env {
  return { ...keys, ...extra } as Env;
}

function context(request: Request, extra: Partial<Env> = {}) {
  return {
    request,
    env: env(extra),
    next: async () => new Response("next", { status: 200 }),
    waitUntil: async () => undefined,
  };
}

const logout = (query: string, extra: Partial<Env> = {}) =>
  onRequestGet(
    context(new Request(`https://limooo.cn/logout${query}`), extra) as never,
  );

describe("logout next validation", () => {
  it("falls back to the site root for an off-site next when Access is unconfigured", async () => {
    const resp = await logout("?next=https://evil.example/phish");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/");
  });

  it("still accepts a relative in-site next", async () => {
    const resp = await logout("?next=%2Fservices");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/services");
  });

  it("accepts an https next on a whitelisted host", async () => {
    const resp = await logout("?next=https%3A%2F%2Fvisitor.limooo.cn%2Fvisitors");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://visitor.limooo.cn/visitors");
  });

  it("rejects control characters instead of throwing a 500", async () => {
    // %0d%0a = CRLF：以前直接进 Location，workerd 构造响应头时抛 TypeError。
    const resp = await logout("?next=%2F%0d%0aX%3A%201");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("https://limooo.cn/");
    expect(resp.headers.get("Location")).not.toContain("\r");
    expect(resp.headers.get("Location")).not.toContain("\n");
  });

  it("rejects protocol-relative and backslash next values", async () => {
    for (const raw of ["//evil.example", "%2F%5Cevil.example", "http://evil.example"]) {
      const resp = await logout(`?next=${raw}`);
      expect(resp.status, `next=${raw}`).toBe(302);
      expect(resp.headers.get("Location"), `next=${raw}`).toBe("https://limooo.cn/");
    }
  });

  it("wraps the sanitised target in the Access logout URL when configured", async () => {
    const resp = await logout("?next=https://evil.example/phish", {
      ACCESS_TEAM_DOMAIN: "limooo.cloudflareaccess.com",
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(
      "https://limooo.cloudflareaccess.com/cdn-cgi/access/logout?redirect_url=" +
        encodeURIComponent("https://limooo.cn/"),
    );
  });
});
