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

/** 由 build.py 自动生成，勿手改；修改配置请编辑 config-contract.json。 */
export const CONTRACT = {
  "schema_version": 1,
  "root_domain": "limooo.cn",
  "supported_langs": [
    "zh-cn",
    "en-us",
    "ja-jp",
    "ko-kr"
  ],
  "default_lang": "en-us",
  "key_fallback_lang": "zh-cn",
  "shared_lang_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "contact.limooo.cn",
    "services.limooo.cn",
    "auth.limooo.cn",
    "redirect.limooo.cn"
  ],
  "lang_cookie": "user_lang_preference",
  "lang_cookie_max_age": 31536000,
  "theme_cookie": "limooo_theme",
  "theme_cookie_max_age": 31536000,
  "gate_cookie": "__gate",
  "session_cookie": "limooo_session_v2",
  "pending_cookie": "limooo_pending_v2",
  "csrf_cookie": "limooo_csrf",
  "gate_ttl_seconds": 3600,
  "session_ttl_seconds": 2592000,
  "pending_ttl_seconds": 600,
  "reveal_max_auth_age_seconds": 600,
  "public_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "services.limooo.cn",
    "contact.limooo.cn",
    "visitor.limooo.cn",
    "account.limooo.cn",
    "auth.limooo.cn",
    "redirect.limooo.cn",
    "image.limooo.cn",
    "images.limooo.cn",
    "status.limooo.cn",
    "*.limooo.cn"
  ],
  "managed_hosts": [
    "limooo.cn",
    "www.limooo.cn",
    "services.limooo.cn",
    "contact.limooo.cn",
    "visitor.limooo.cn",
    "account.limooo.cn",
    "auth.limooo.cn",
    "redirect.limooo.cn",
    "images.limooo.cn",
    "image.limooo.cn"
  ],
  "page_routes": {
    "limooo.cn": {
      "/": "index.html",
      "/index.html": "index.html",
      "/services": "services.html",
      "/contact": "contact.html"
    },
    "www.limooo.cn": {
      "/": "index.html",
      "/index.html": "index.html",
      "/services": "services.html",
      "/contact": "contact.html"
    },
    "services.limooo.cn": {
      "/": "services.html",
      "/index.html": "services.html",
      "/services": "services.html"
    },
    "contact.limooo.cn": {
      "/": "contact.html",
      "/index.html": "contact.html",
      "/contact": "contact.html"
    },
    "visitor.limooo.cn": {
      "/": "visitor.html",
      "/index.html": "visitor.html",
      "/visitor": "visitor.html"
    },
    "account.limooo.cn": {
      "/": "apple-account.html",
      "/index.html": "apple-account.html",
      "/apple": "apple-account.html"
    },
    "auth.limooo.cn": {
      "/__gate": "auth.html"
    },
    "redirect.limooo.cn": {
      "/": "redirect.html",
      "/r": "redirect.html"
    },
    "images.limooo.cn": {
      "/": "images.html",
      "/index.html": "images.html",
      "/portfolio": "images.html",
      "/qr-codes": "images.html",
      "/icons": "images.html"
    }
  },
  "image_asset_host": "images.limooo.cn",
  "image_watermark_host": "image.limooo.cn",
  "gate_trust": {
    "verified_bot": true,
    "ua_allowlist_enabled": false
  },
  "observability_hmac_env": "OBSERVABILITY_HMAC_KEY",
  "whitelist_file": "data/whitelist.txt"
} as const;

export const ROOT_DOMAIN = CONTRACT.root_domain;
export const BASE_URL = `https://${ROOT_DOMAIN}`;
export const WWW_HOSTNAME = `www.${ROOT_DOMAIN}`;
export const VISITOR_HOSTNAME = `visitor.${ROOT_DOMAIN}`;
export const APPLE_ACCOUNT_HOSTNAME = `account.${ROOT_DOMAIN}`;
export const REDIRECT_HOSTNAME = `redirect.${ROOT_DOMAIN}`;
export const GATE_HOSTNAME = `auth.${ROOT_DOMAIN}`;
export const IMAGES_HOSTNAME = `images.${ROOT_DOMAIN}`;
export const APPLE_ACCOUNT_DOMAIN = `@${APPLE_ACCOUNT_HOSTNAME}`;
export const PUBLIC_HOSTS: Set<string> = new Set(CONTRACT.public_hosts);
export const PAGE_ROUTES: Record<string, Record<string, string>> = CONTRACT.page_routes;
export const IMAGE_ASSET_HOSTNAME = CONTRACT.image_asset_host;
export const IMAGE_WATERMARK_HOSTNAME = CONTRACT.image_watermark_host;
export const GATE_TRUST = CONTRACT.gate_trust;
export const SUPPORTED_LANGS = CONTRACT.supported_langs;
export const DEFAULT_LANG = CONTRACT.default_lang;
export const LANG_COOKIE = CONTRACT.lang_cookie;
export const LANG_COOKIE_MAX_AGE = CONTRACT.lang_cookie_max_age;
export const GATE_COOKIE = CONTRACT.gate_cookie;
export const SESSION_COOKIE = CONTRACT.session_cookie;
export const PENDING_COOKIE = CONTRACT.pending_cookie;
export const CSRF_COOKIE = CONTRACT.csrf_cookie;
export const GATE_TTL_SECONDS = CONTRACT.gate_ttl_seconds;
export const SESSION_TTL_SECONDS = CONTRACT.session_ttl_seconds;
export const REVEAL_MAX_AUTH_AGE_SECONDS = CONTRACT.reveal_max_auth_age_seconds;
