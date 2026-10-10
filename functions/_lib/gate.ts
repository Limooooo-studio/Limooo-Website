/** 人机验证门禁：cookie 校验/签发、Turnstile 验证、门禁页渲染、配置接口。 */

import { queryAll } from "./d1";
import { networkAddress, normalizeIp } from "./cidr";
import { logEvent } from "./logging";
import type { RequestContext } from "./routing";
import {
  clientCountryForLogs,
  clientIpForLogs,
  detectLang,
  escapeHtml,
  isGateTrustedIp,
  preserveSetCookie,
  safeNextPath,
  sanitizeHost,
  withLangCookie,
} from "./routing";
import { isTrustedCrawler } from "./tracking";
import {
  BASE_URL,
  GATE_COOKIE,
  GATE_TTL_SECONDS,
  ROOT_DOMAIN,
} from "./config";
import { GATE_I18N } from "../_data/runtime";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 3000;

/** 门禁事件日志异步写入，不阻塞验证结果的返回。 */
function deferLog(context: RequestContext, promise: Promise<unknown>): void {
  if (typeof context.waitUntil === "function") {
    context.waitUntil(promise);
  } else {
    void promise;
  }
}


/**
 * cookie 格式：`<签发时间戳>.<过期时间戳>.<HMAC-SHA256 hex 签名>`。
 *
 * 签名覆盖完整的 `签发.过期` 载荷，因此 cookie 既不能被篡改，也不能被
 * 用旧 cookie 的签名拼出新过期时间。
 *
 * 历史上这里只签过期时间，**不签签发时间**，于是每次请求都能重新签出一个
 * 「续满 TTL」的新 cookie；只要 TTL 短于访客的访问间隔就会反复回到门禁页。
 * 现在签发时间进入签名，续期是显式的、有上限的：距签发超过
 * `GATE_RENEW_AFTER_SECONDS`（即走完 TTL 的 3/4）才续期一次，因此
 * 「1 小时会话」是可验证的承诺，而不是随请求漂移的滑动窗口。
 */
export const GATE_RENEW_AFTER_SECONDS = Math.floor(GATE_TTL_SECONDS * 0.75);

/** 校验失败的分类，只用于诊断日志，不回传给访客以免泄露校验细节。 */
export type GateCookieReason =
  | "ok"
  | "absent"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "future_issued";

export interface GateCookieState {
  valid: boolean;
  /** 请求里是否存在 __gate（同名重复只要求至少有一枚）。 */
  present: boolean;
  /** 距离过期不足 1/4 TTL，值得在本次响应里续期。 */
  shouldRenew: boolean;
  reason: GateCookieReason;
}

/**
 * 取出同名 cookie 的全部取值。
 *
 * 浏览器允许同名 cookie 在**不同作用域**（host-only 与 Domain=、不同 Path）下并存，
 * 并把它们全部放进同一个 Cookie 请求头。只取第一枚会拿到作用域更早/更旧的那份，
 * 表现就是「刚刚验证通过，下一次请求又被拦」——因此门禁必须逐枚校验。
 */
export function allCookieValues(name: string, header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/** 校验 __gate cookie：签名、格式与过期时间三者都通过才算有效。 */
export async function readGateCookie(
  value: string | undefined,
  key: string,
): Promise<GateCookieState> {
  const present = Boolean(value);
  const fail = (reason: GateCookieReason): GateCookieState => ({
    valid: false,
    present,
    shouldRenew: false,
    reason,
  });
  if (!present) return fail("absent");
  if (!key) return fail("malformed");

  const parts = (value as string).split(".");
  if (parts.length !== 3) return fail("malformed");
  const [issuedRaw, expiryRaw, signature] = parts;
  if (!/^\d{10,}$/.test(issuedRaw) || !/^\d{10,}$/.test(expiryRaw)) return fail("malformed");
  if (!/^[0-9a-f]{64}$/.test(signature)) return fail("malformed");

  const expected = await hmacSha256Hex(key, `${issuedRaw}.${expiryRaw}`);
  if (!timingSafeEqual(signature, expected)) return fail("bad_signature");

  const issued = Number(issuedRaw);
  const expiry = Number(expiryRaw);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expiry)) return fail("malformed");
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now) return fail("expired");
  // 签发时间在未来（时钟漂移或伪造）一律视为无效，避免出现永不续期的 cookie。
  if (issued > now + 60) return fail("future_issued");

  return {
    valid: true,
    present: true,
    shouldRenew: now - issued >= GATE_RENEW_AFTER_SECONDS,
    reason: "ok",
  };
}

/** 签发 __gate cookie（Domain=. <root_domain>，TTL 来自契约，默认 1 小时）。 */
export async function mintGateCookie(key: string): Promise<string> {
  const ttlSeconds = GATE_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + ttlSeconds;
  const payload = `${now}.${expiry}`;
  const signature = await hmacSha256Hex(key, payload);
  return `${GATE_COOKIE}=${payload}.${signature}; Domain=.${ROOT_DOMAIN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}

/**
 * 清掉早期可能存在的 host-only `__gate`（没有 Domain 属性）。
 *
 * host-only 与 Domain=.limooo.cn 两种作用域下的同名 cookie 会**并存**并同时发送，
 * 若旧的那枚一直排在前面且已失效，就会稳定地把有效的那枚挡掉。签发新 cookie 时
 * 顺手删除 host-only 变体，避免这种「验证成功却仍被拦」的僵尸态。
 */
export function purgeLegacyGateCookie(): string {
  return `${GATE_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

/** 一次签发要下发的全部 Set-Cookie：先清旧作用域，再写新的域级 cookie。 */
export async function gateCookieHeaders(key: string): Promise<string[]> {
  return [purgeLegacyGateCookie(), await mintGateCookie(key)];
}

export interface GateTrustState {
  /** 白名单 IP 或 Cloudflare 已验证爬虫：本就免验证，不需要 cookie。 */
  trusted: boolean;
  /** 持有有效 __gate cookie。 */
  cookieValid: boolean;
  /** 本次请求应续签 cookie（cookie 仍有效但已走过 3/4 TTL）。 */
  shouldRenew: boolean;
  /** 请求里带了 __gate 但没有一枚有效：用于诊断「验证后仍被拦」。 */
  cookiePresent: boolean;
  /** 校验结论分类。 */
  cookieReason: GateCookieReason;
}

/**
 * 门禁放行判定的唯一实现。
 *
 * 中间件与 /gate 都必须调用它，避免两处各自拼「白名单 || 爬虫 || cookie」
 * 导致语义漂移——历史上正是两份相似的判定逻辑让「看似已通过却又被要求
 * 验证」难以定位。
 *
 * 同名 __gate 可能有多枚（作用域不同会并存），这里逐枚校验、任意一枚有效即放行。
 */
export async function resolveGateTrust(
  context: RequestContext,
): Promise<GateTrustState> {
  const { request, env } = context;
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const trusted = isGateTrustedIp(ip) || isTrustedCrawler(request);

  const values = allCookieValues(GATE_COOKIE, request.headers.get("Cookie"));
  let best: GateCookieState = {
    valid: false,
    present: values.length > 0,
    shouldRenew: false,
    reason: values.length > 0 ? "malformed" : "absent",
  };
  for (const value of values) {
    const state = await readGateCookie(value, env.GATE_HMAC_KEY);
    if (state.valid) {
      best = state;
      break;
    }
    if (state.present) best = state;
  }

  return {
    trusted,
    cookieValid: best.valid,
    shouldRenew: best.shouldRenew,
    cookiePresent: best.present,
    cookieReason: best.reason,
  };
}

/**
 * GET /gate：唯一对外的门禁入口。
 *
 * 已通过者 302 回原页（原主机 + 原路径），未通过者原地渲染门禁页。
 * 「是否已通过」与「是否需要续期」都收敛到 resolveGateTrust 一处，
 * 续期只发生在 cookie 走完 3/4 TTL 时，因此 1 小时会话是稳定承诺，
 * 不会像旧的滑动重签那样随请求漂移。
 */
export async function handleGateEntry(context: RequestContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const forceChallenge = url.searchParams.get("challenge") === "1";
  const host = sanitizeHost(url.searchParams.get("host"));
  const next = safeNextPath(url.searchParams.get("next") ?? "/");
  const trust = await resolveGateTrust(context);
  const passed = trust.trusted || trust.cookieValid;

  if (passed && !forceChallenge) {
    deferLog(
      context,
      logEvent(env, "gate_entry", request, {
        outcome: "passed",
        status: 302,
        message: trust.trusted ? "trusted" : trust.shouldRenew ? "renewed" : "cookie",
      }),
    );
    let resp = Response.redirect(`https://${host}${next}`, 302);
    // 白名单/爬虫本来就没有 cookie，需要补一枚；持 cookie 者只在临近过期时续签。
    if (trust.trusted || trust.shouldRenew) {
      const headers = new Headers(resp.headers);
      preserveSetCookie(headers, resp.headers);
      for (const value of await gateCookieHeaders(env.GATE_HMAC_KEY)) {
        headers.append("Set-Cookie", value);
      }
      resp = new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    }
    return withLangCookie(request, resp);
  }

  return renderGatePage(context, { host, next });
}

/**
 * GET /__gate：旧入口，保留但一律 308 到等价的 /gate。
 *
 * 线上可能还有正在排队的请求和访客书签指向它；把它固定成跳转而不是
 * 第二套判定逻辑，可以确保 /gate 是唯一被前端与文档引用的地址，
 * 不会再出现「两个入口判定不一致导致反复验证」。查询参数原样保留。
 */
export function handleLegacyGateRedirect(context: RequestContext): Response {
  const url = new URL(context.request.url);
  const target = new URL(`https://${url.hostname}/gate`);
  target.search = url.search;
  return new Response(null, {
    status: 308,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

/** GET /gate/config 与 /__gate/config：只下发非敏感运行时配置，不写死 sitekey 到 HTML。 */
export function handleGateConfig(context: RequestContext): Response {
  const { env, request } = context;
  return Response.json(
    {
      sitekey: env.TURNSTILE_SITEKEY ?? "",
      i18n: GATE_I18N,
      lang: detectLang(request),
      root_domain: ROOT_DOMAIN,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** GET /__gate/diag：动态诊断信息，页面其余部分可缓存。 */
export function handleGateDiag(context: RequestContext): Response {
  const { request } = context;
  return Response.json(
    {
      country: clientCountryForLogs(request) || "—",
      ip: clientIpForLogs(request) || "—",
      ray: request.headers.get("CF-Ray") || "—",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export interface GateRenderOptions {
  next?: string;
  host?: string;
  errorKey?: string;
  unavailable?: boolean;
  /** 已通过门禁的访客仍要求看这张页（门禁主机原地渲染）时为 true，状态码用 200。 */
  passed?: boolean;
}

/** 从生成好的 <lang>/auth.html 读取门禁页，只注入 host/next/error/lang。 */
export async function renderGatePage(
  context: RequestContext,
  opts: GateRenderOptions,
): Promise<Response> {
  const { request, env } = context;
  const host = sanitizeHost(opts.host);
  const next = safeNextPath(opts.next ?? "/");
  const lang = detectLang(request);
  const status = opts.unavailable ? 503 : opts.passed ? 200 : 403;
  if (!env.ASSETS) return new Response("Gate page unavailable", { status: 503 });

  const asset = await env.ASSETS.fetch(new URL(`/${lang}/auth.html`, BASE_URL));
  if (!asset.ok) return new Response("Gate page unavailable", { status: 503 });
  const source = await asset.text();
  const html = source
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{host}}", escapeHtml(host))
    .replaceAll("{{next}}", escapeHtml(next))
    .replaceAll("{{error}}", escapeHtml(opts.errorKey ?? ""));

  // 门禁页一律不可缓存。
  //
  // 这张页会**原地**替换真实内容的 URL 并返回 403；曾经给它 `max-age=300`
  // （浏览器私有缓存）导致验证通过后 `location.replace` 回同一 URL 时，
  // 浏览器可能直接重放那份 403 挑战页 —— 表现就是「验证成功又跳回验证页」，
  // 且每次重放都再触发一次 verify，形成稳定死循环。挑战页没有任何缓存价值，
  // 直接 no-store 才是正确语义。
  return withLangCookie(
    request,
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Vary": "Cookie",
      },
    }),
  );
}

interface BlockedRow {
  cidr: string;
  network: string;
  prefix: number;
}

/**
 * 记录未通过门禁的来源；同一 IP 在 24 小时内第 3 次失败时精确封禁该 IP。
 *
 * 计数只保存 HMAC 后的 IP，封禁时才把规范化地址写入 blocked_ips。成功写入
 * blocked_ips 后删除计数器，避免被封来源继续占用表空间或反复触发封禁审计。
 */
/* Automatic gate-failure threshold blocking has been removed. */
async function removedBanAfterGateFailures(
  _env: import("./env").Env,
  _request: Request,
  _ip: string,
): Promise<boolean> {
  return false;
/*
  if (!env.DB || !env.OBSERVABILITY_HMAC_KEY) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const parsed = parseCidr(normalized);
  if (!parsed) return false;

  const hashedIp = await ipHash(normalized, env);
  if (!hashedIp) return false;

  try {
    const rows = await queryAll<{ failures: number }>(
      env.DB,
      `INSERT INTO gate_failures (ip_hash, failures, window_started_at, last_seen_at)
       VALUES (?, 1, unixepoch(), unixepoch())
       ON CONFLICT(ip_hash) DO UPDATE SET
         failures = CASE
           WHEN gate_failures.last_seen_at < unixepoch() - ? THEN 1
           ELSE gate_failures.failures + 1
         END,
         window_started_at = CASE
           WHEN gate_failures.last_seen_at < unixepoch() - ? THEN unixepoch()
           ELSE gate_failures.window_started_at
         END,
         last_seen_at = unixepoch()
       RETURNING failures`,
      hashedIp,
      GATE_FAILURE_WINDOW_SECONDS,
      GATE_FAILURE_WINDOW_SECONDS,
    );
    if ((rows[0]?.failures ?? 0) < GATE_FAILURE_BAN_THRESHOLD) return false;

    const now = "datetime('now')";
    const reason = `${GATE_FAILURE_BAN_THRESHOLD} unverified gate requests within 24h`;
    const mutationSql =
      `INSERT INTO blocked_ips
         (cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active)
       VALUES (?, ?, ?, ?, 'gate/threshold', ${now}, ${now}, 'gate-threshold', 1)
       ON CONFLICT(cidr) DO UPDATE SET
         network = excluded.network, prefix = excluded.prefix, reason = excluded.reason,
         source = 'gate/threshold', updated_at = excluded.updated_at,
         updated_by = 'gate-threshold', active = 1`;
    const auditSql =
      `INSERT INTO blocklist_audit
         (cidr, network, prefix, action, actor, reason, source, previous_reason,
          previous_source, previous_updated_at, created_at)
       VALUES (?, ?, ?, 'threshold_block', 'gate-threshold', ?, 'gate/threshold',
               '', '', '', ${now})`;
    const clearSql = "DELETE FROM gate_failures WHERE ip_hash = ?";
    const statements = [
      env.DB.prepare(mutationSql).bind(parsed.cidr, parsed.network, parsed.prefix, reason),
      env.DB.prepare(auditSql).bind(parsed.cidr, parsed.network, parsed.prefix, reason),
      env.DB.prepare(clearSql).bind(hashedIp),
    ];
    const batched = await executeBatch(env.DB, statements);
    if (!batched) {
      if (!(await execute(env.DB, mutationSql, parsed.cidr, parsed.network, parsed.prefix, reason))) return false;
      if (!(await execute(env.DB, auditSql, parsed.cidr, parsed.network, parsed.prefix, reason))) return false;
      if (!(await execute(env.DB, clearSql, hashedIp))) return false;
    }
    await logEvent(env, "gate_threshold_block", request, {
      outcome: "blocked",
      status: 403,
      ip: normalized,
      message: `cidr=${parsed.cidr}; failures=${GATE_FAILURE_BAN_THRESHOLD}`,
    });
    return true;
  } catch {
    // 封禁计数不可用时维持门禁原有行为，不能误封。
    return false;
  }*/
}

/** 封禁检查：规范化请求 IP 后，按 blocked_ips(network, prefix) 精确查询（DB 异常时放行）。 */
export async function isBlocked(
  env: { DB?: import("./env").Env["DB"] },
  request: Request,
  ip: string,
): Promise<boolean> {
  if (!env.DB || !ip) return false;
  const url = new URL(request.url);
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const maxPrefix = normalized.includes(":") ? 128 : 32;
  const candidates: Array<[string, number]> = [];
  for (let prefix = 0; prefix <= maxPrefix; prefix++) {
    const network = networkAddress(normalized, prefix);
    if (network) candidates.push([network, prefix]);
  }
  try {
    let matched: BlockedRow | null = null;
    // 每对 network/prefix 占两个绑定参数；49 对可保持在 D1 单语句 100 参数限制内。
    // 因而 IPv4 只需一次查询，IPv6 由原先七次降为三次。
    for (let start = 0; start < candidates.length; start += 49) {
      const chunk = candidates.slice(start, start + 49);
      const conditions = chunk.map(() => "(network = ? AND prefix = ?)").join(" OR ");
      const rows = await queryAll<BlockedRow>(
        env.DB,
        `SELECT cidr, network, prefix
         FROM blocked_ips
         WHERE active = 1 AND (${conditions})
         ORDER BY prefix DESC
         LIMIT 1`,
        ...chunk.flatMap(([network, prefix]) => [network, prefix]),
      );
      for (const row of rows) {
        if (!matched || row.prefix > matched.prefix) matched = row;
      }
    }
    if (matched) {
      await logEvent(env as never, "block_match", request, {
        ip: normalized,
        path: url.pathname,
        outcome: "blocked",
        status: 403,
        message: `cidr=${matched.cidr}`,
      });
      return true;
    }
  } catch {
    // fail-open：DB 不可用时不做应用层拦截。
  }
  return false;
}

/**
 * 调用 Turnstile siteverify；`remoteip` 只来自 `CF-Connecting-IP`。
 *
 * 导出仅为测试可断言「访客自带的转发头不会进入 remoteip」；生产调用点只有
 * `handleVerify` 一处。
 */
export async function verifyTurnstile(
  token: string,
  remoteip: string,
  secret: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const resp = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip }).toString(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`siteverify HTTP ${resp.status}`);
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } finally {
    clearTimeout(timer);
  }
}

function wantsJson(request: Request): boolean {
  return request.headers.get("Accept")?.includes("application/json") ?? false;
}

function gateTarget(host: string, path: string): string {
  return `https://${host}${path}`;
}

/** POST /__gate/verify：校验 Turnstile，成功签发 cookie。
 *
 * 门禁页通过 fetch 调用本接口，响应只写 Cookie，不经过 redirect 子域；
 * 无 JavaScript 时仍直接回原站，作为可访问性降级。
 */
export async function handleVerify(context: RequestContext): Promise<Response> {
  const { request, env } = context;
  const startedAt = Date.now();
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    deferLog(
      context,
      logEvent(env, "gate_verify", request, {
        outcome: "failed",
        status: 400,
        durationMs: Date.now() - startedAt,
        message: "invalid_form",
      }),
    );
    return renderGatePage(context, { errorKey: "invalid" });
  }

  const token = form.get("cf-turnstile-response")?.toString() ?? "";
  const next = safeNextPath(form.get("next")?.toString() ?? null);
  const host = sanitizeHost(form.get("host")?.toString() ?? null);
  // Turnstile 会拿 remoteip 跟解题来源比对；只传 Cloudflare 认定的连接 IP，
  // 访客自带的转发头一律不采信（否则等于让访客自己声明校验依据）。
  const remoteip = clientIpForLogs(request);

  let success = false;
  let unavailable = false;
  if (!env.TURNSTILE_SECRET) {
    unavailable = true;
  } else {
    try {
      success = token !== "" && (await verifyTurnstile(token, remoteip, env.TURNSTILE_SECRET));
    } catch {
      unavailable = true;
    }
  }

  if (!success) {
    deferLog(
      context,
      logEvent(env, "gate_verify", request, {
        outcome: unavailable ? "unavailable" : "failed",
        status: unavailable ? 503 : 403,
        durationMs: Date.now() - startedAt,
        message: unavailable
          ? env.TURNSTILE_SECRET
            ? "turnstile_unavailable"
            : "turnstile_secret_missing"
          : token
            ? "turnstile_rejected"
            : "missing_token",
      }),
    );
    const errorKey = unavailable ? "unavailable" : "failed";
    if (wantsJson(request)) {
      return Response.json(
        { ok: false, error: errorKey },
        { status: unavailable ? 503 : 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return renderGatePage(context, {
      host,
      next,
      unavailable,
      errorKey,
    });
  }

  // 先清 host-only 旧作用域，再写域级新 cookie。
  //
  // 这里刻意下发两条 Set-Cookie：旧的同名 host-only cookie 会与新的域级 cookie
  // 并存并一直排在请求头前面，只写一条新 cookie 并不能解除它的遮挡。
  // 多条 Set-Cookie 由 preserveSetCookie 保证不被合并（Safari 只认第一条的坑）。
  const cookies = await gateCookieHeaders(env.GATE_HMAC_KEY);
  deferLog(
    context,
    logEvent(env, "gate_verify", request, {
      outcome: "success",
      status: 204,
      durationMs: Date.now() - startedAt,
      message: "cookie_issued",
    }),
  );

  if (wantsJson(request)) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const value of cookies) headers.append("Set-Cookie", value);
    return new Response(null, { status: 204, headers });
  }

  const headers = new Headers({
    Location: gateTarget(host, next),
    "Cache-Control": "no-store",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}
