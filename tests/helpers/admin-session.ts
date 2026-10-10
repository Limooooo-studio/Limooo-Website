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
 * `functions/_lib/session` 的模块桩，供 7 个 admin 路由测试共用（docs/22 W5-15）。
 *
 * 位置说明（为什么在 `tests/` 而不是 `functions/_lib/__mocks__/`）：
 * `tests/` 在 Pages 项目的 `functions/` 根之外，`wrangler pages functions build`
 * 从根上就看不见它。实测（隔离副本里做的对照）：把同一个文件放进
 * `functions/_lib/` 且**没有任何路由 import** 时不会进 bundle，但只要有一条路由
 * import 它，产物里立刻出现（179283 vs 178926 字节）——也就是说
 * 「放在 functions/ 下不进 bundle」只是当前 wrangler 的扫描细节，不是保证；
 * 放在 `tests/` 则是结构上不可能被生产打包。
 * `vitest.config.ts` 的 `include` 只收 `functions/` 下的 `.test.ts` 与三个
 * Worker 的 `.test.ts`，所以这份 helper 不会被当成用例收集（名字也不以
 * `.test.ts` 结尾）。
 * 「不进 bundle」的验证：对本仓库跑
 * `npx wrangler pages functions build --outdir=<dir> --project-directory=.`，
 * 与本改动前的产物逐字节相同（只差一行 wrangler 临时目录名的注释），
 * 且 `grep -c createSessionModuleMock index.js` = 0（见 docs/22 执行记录）。
 *
 * 语义与生产 `requireAdminSession`（`functions/_lib/session.ts`）**逐条对齐**：
 * `requireAuth` 抛错（`AuthSessionUnavailableError`，D1 撤销表不可用）→ 委托给
 * `authUnavailableResponse()`（默认 503；三个测试文件会在 `beforeEach` 里把它
 * 覆盖成生产的 `{ error: "auth_sessions_unavailable" }` 体）；
 * 未登录 → 401 `{error:"未登录"}` + `Cache-Control: no-store`；
 * 非 admin → 403 `{error: forbidden}` + `Cache-Control: no-store`，`forbidden`
 * 默认沿用生产的「只读账户，无写入权限」；通过则返回 `{ session }`。
 *
 * 注意：原先把这段桩复制进 7 个文件时**漏了 503 分支**（`auth_unavailable` 在
 * 那些文件里被 `beforeEach` 配好却永远走不到，是死配置），审计 W5-15 点名了这一点；
 * 这里补上 catch 之后，`mockRejectedValueOnce` 才真的能验「D1 down → 503」。
 *
 * 用法（`vi.mock` 工厂里动态 import，工厂内不许引用外层变量）：
 *
 * ```ts
 * vi.mock("../../_lib/session", async () => {
 *   const { createSessionModuleMock } = await import("../../../tests/helpers/admin-session");
 *   return createSessionModuleMock();
 * });
 * ```
 */

import { vi } from "vitest";

/** 与生产 `ADMIN_REQUIRED_MESSAGE` 同文案（只读账户 / 非管理员的默认拒绝语）。 */
export const ADMIN_REQUIRED_MESSAGE = "只读账户，无写入权限";

/** `functions/_lib/session` 的模块桩；每个测试文件调用一次（模块注册表按文件隔离）。 */
export function createSessionModuleMock() {
  const requireAuth = vi.fn();
  // 默认体与原内联桩逐字相同（纯文本 503）；需要生产 JSON 体的文件自行覆盖。
  const authUnavailableResponse = vi.fn(
    () => new Response("unavailable", { status: 503 }),
  );
  // 与生产同策略：委托给桩化的 requireAuth，未登录 401、非 admin 403、
  // requireAuth 抛错 → 503（fail-closed，不允许凭 cookie 放行）。
  const requireAdminSession = vi.fn(
    async (env: unknown, request: Request, forbidden: string = ADMIN_REQUIRED_MESSAGE) => {
      let session: unknown;
      try {
        session = await requireAuth(env, request);
      } catch {
        return authUnavailableResponse();
      }
      if (!session) {
        return Response.json(
          { error: "未登录" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }
      if ((session as { role?: string }).role !== "admin") {
        return Response.json(
          { error: forbidden },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return { session };
    },
  );
  return { requireAuth, authUnavailableResponse, requireAdminSession };
}
