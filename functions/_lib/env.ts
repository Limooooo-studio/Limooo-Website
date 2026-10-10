import type { D1Database } from "./d1";

export interface Env {
  // 门禁（阶段 1）
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET: string;
  GATE_HMAC_KEY: string;
  // 可观测性：独立于 GATE_HMAC_KEY 的 IP 哈希密钥；缺失时记录为空串，不降级复用
  OBSERVABILITY_HMAC_KEY?: string;
  // 登录（Cloudflare Access，唯一身份来源；docs/17 §11.10）
  /** Zero Trust team domain，如 https://limooo.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** 逗号分隔的 AUD 列表：命中即 admin。 */
  ACCESS_ADMIN_AUDS?: string;
  /** 逗号分隔的 AUD 列表：命中即 viewer（admin 优先）。 */
  ACCESS_VIEWER_AUDS?: string;
  SESSION_HMAC_KEY?: string;
  // 本地开发用：设 "1" 才放行 http(s)://localhost|127.0.0.1 的 CSRF Origin，
  // 生产不设即默认关闭（只写进本地 .dev.vars，不进 Pages Secret）
  ALLOW_LOCAL_ORIGINS?: string;
  // 访客行 IP 加密（Fernet 密钥，独立密钥，只服务 visitor_rollups.ip_enc）
  VISITOR_IP_KEY?: string;
  // Apple Account 密码加密（Fernet 密钥，与现有 Flask 部署共用）
  APPLE_ACCOUNT_ENCRYPTION_KEY?: string;
  // D1（阶段 3：访客统计 / 封禁名单 / Apple Account）
  DB?: D1Database;
  // Pages 静态资源绑定（中间件按语言取预渲染页面）
  ASSETS?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}
