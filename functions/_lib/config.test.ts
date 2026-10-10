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

/** 共享配置模块冒烟测试：契约常量在两端可读取。 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  GATE_COOKIE,
  LANG_COOKIE,
  PENDING_COOKIE,
  ROOT_DOMAIN,
  SESSION_COOKIE,
  SUPPORTED_LANGS,
} from "./config";

describe("shared config", () => {
  it("has the expected shared constants", () => {
    expect(ROOT_DOMAIN).toBe("limooo.cn");
    expect(DEFAULT_LANG).toBe("en-us");
    expect(SUPPORTED_LANGS).toContain("zh-cn");
    expect(GATE_COOKIE).toBe("__gate");
    expect(SESSION_COOKIE).toBe("limooo_session_v2");
    expect(PENDING_COOKIE).toBe("limooo_pending_v2");
    expect(LANG_COOKIE).toBe("user_lang_preference");
  });
});
