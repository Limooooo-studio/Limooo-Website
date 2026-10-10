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

import { describe, expect, it, vi } from "vitest";
import { archivePreviousDay } from "./index";

function env() {
  const put = vi.fn().mockResolvedValue({ key: "ok" });
  const all = vi.fn().mockResolvedValue({ results: [{ id: 1, status: 302 }], success: true });
  const bind = vi.fn().mockReturnValue({ all });
  return {
    env: {
      DB: { prepare: vi.fn().mockReturnValue({ bind }) },
      ARCHIVE: { put },
    },
    put,
    bind,
  } as const;
}

describe("d1 archive", () => {
  it("archives the previous UTC day to one gzip object per table", async () => {
    const f = env();
    const counts = await archivePreviousDay(f.env as never, new Date("2026-09-09T00:00:00Z"));
    expect(counts).toEqual({
      visitor_rollups: 1,
      visitors_v2: 1,
      ray_log_v2: 1,
      events: 1,
    });
    expect(f.put).toHaveBeenCalledTimes(4);
    expect(f.put.mock.calls[0][0]).toBe("analytics/2026_09_08/visitor_rollups.jsonl.gz");
    expect(f.put.mock.calls[0][2]).toEqual({
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    });
  });
});
