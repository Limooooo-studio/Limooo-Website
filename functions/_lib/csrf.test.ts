/** CSRF 双提交保护测试；不读取真实密钥。 */

import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { createCsrfToken, csrfCookieHeader, verifyCsrf } from "./csrf";

const env = {
  SESSION_HMAC_KEY: "csrf-test-secret",
  GATE_HMAC_KEY: "csrf-test-gate",
} as Env;

const SID_A = "sid-a";
const SID_B = "sid-b";

function request(
  origin: string,
  token: string,
  cookieToken = token,
  method = "POST",
): Request {
  return new Request("https://account.limooo.cn/api/apple-account/accounts/1/reveal", {
    method,
    headers: {
      Origin: origin,
      "X-CSRF-Token": token,
      Cookie: `limooo_csrf=${cookieToken}`,
    },
  });
}

describe("csrf", () => {
  it("round-trips a signed token with matching cookie and header", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("https://account.limooo.cn", token), SID_A)).toBe(true);
  });

  it("rejects missing or mismatched header/cookie", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("https://account.limooo.cn", "", token), SID_A)).toBe(false);
    expect(
      await verifyCsrf(env, request("https://account.limooo.cn", token, "different"), SID_A),
    ).toBe(false);
  });

  it("rejects a token issued for a different session", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("https://account.limooo.cn", token), SID_B)).toBe(false);
    // 同一个 token 在自己的会话里仍然有效，排除“因为签名坏了一律拒绝”的假阴性。
    expect(await verifyCsrf(env, request("https://account.limooo.cn", token), SID_A)).toBe(true);
  });

  it("rejects an empty session id even when the signature matches", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("https://account.limooo.cn", token), "")).toBe(false);
    await expect(createCsrfToken(env, "")).rejects.toThrow();
  });

  it("rejects cross-site origins", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("https://evil.example", token), SID_A)).toBe(false);
  });

  it("rejects localhost origins unless ALLOW_LOCAL_ORIGINS=1 is set", async () => {
    const { token } = await createCsrfToken(env, SID_A);
    expect(await verifyCsrf(env, request("http://localhost:8788", token), SID_A)).toBe(false);
    expect(await verifyCsrf(env, request("http://127.0.0.1:8080", token), SID_A)).toBe(false);

    const localEnv = { ...env, ALLOW_LOCAL_ORIGINS: "1" } as Env;
    expect(await verifyCsrf(localEnv, request("http://localhost:8788", token), SID_A)).toBe(true);
    expect(await verifyCsrf(localEnv, request("http://127.0.0.1:8080", token), SID_A)).toBe(true);
    // 除了 "1" 之外的值一律视为关闭
    const offEnv = { ...env, ALLOW_LOCAL_ORIGINS: "true" } as Env;
    expect(await verifyCsrf(offEnv, request("http://localhost:8788", token), SID_A)).toBe(false);
  });

  it("cookie header is not HttpOnly and can be read by JavaScript", () => {
    const header = csrfCookieHeader("token", true);
    expect(header).not.toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Secure");
  });
});
