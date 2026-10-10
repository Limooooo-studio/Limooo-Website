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
 * Limooo 统一安全响应头（Pages Functions 侧）。
 *
 * 唯一文案源是 `ops/security-headers.json`；本文件是 Pages 构建/运行时镜像。
 * 修改时请同时更新 JSON，并运行 `python3 ops/check_security_headers.py`。
 */

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy":
    "default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'self' https://challenges.cloudflare.com http://static.cloudflareinsights.com https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data: https://image.limooo.cn https://images.limooo.cn; font-src 'self' data: https://fonts.limooo.cn; connect-src 'self' https://image.limooo.cn https://images.limooo.cn https://challenges.cloudflare.com http://cloudflareinsights.com https://cloudflareinsights.com; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'self'; form-action 'self' https://*.limooo.cn",
};
