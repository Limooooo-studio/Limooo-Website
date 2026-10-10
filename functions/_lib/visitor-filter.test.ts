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

/** visitor-filter.js 纯函数测试：本地状态筛选不依赖 DOM / 网络。 */

import { describe, expect, it } from "vitest";
import { filterMarkers } from "../../src/static/js/visitor-filter.js";

describe("filterMarkers", () => {
  const markers = [
    { ip_hash: "a", statuses: { "200": 3, "404": 1 } },
    { ip_hash: "b", statuses: { "500": 2 } },
    { ip_hash: "c", statuses: {} },
    { ip_hash: "d" },
  ];

  it("returns a copy for all", () => {
    const result = filterMarkers(markers, "all");
    expect(result).toEqual(markers);
    expect(result).not.toBe(markers);
  });

  it("keeps markers whose statuses contain the selected status", () => {
    expect(filterMarkers(markers, "200")).toEqual([markers[0]]);
    expect(filterMarkers(markers, "500")).toEqual([markers[1]]);
  });

  it("filters out missing or empty statuses without mutating input", () => {
    const result = filterMarkers(markers, "404");
    expect(result).toEqual([markers[0]]);
    expect(markers).toHaveLength(4);
    expect(markers[2].statuses).toEqual({});
  });

  it("is case/string consistent for numeric status keys", () => {
    expect(filterMarkers(markers, "200")[0]).toBe(markers[0]);
    expect(filterMarkers([{ ip_hash: "x", statuses: { 200: 1 } }], "200")).toHaveLength(1);
  });

  it("handles non-array input safely", () => {
    expect(filterMarkers(null, "all")).toEqual([]);
    expect(filterMarkers(undefined, "200")).toEqual([]);
  });

  it("preserves input order", () => {
    const result = filterMarkers(
      [
        { ip_hash: "z", statuses: { "200": 1 } },
        { ip_hash: "a", statuses: { "500": 1 } },
        { ip_hash: "m", statuses: { "200": 1 } },
      ],
      "200",
    );
    expect(result.map((m) => m.ip_hash)).toEqual(["z", "m"]);
  });
});
