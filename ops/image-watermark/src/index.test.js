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
 * image-watermark 路由纯函数测试（docs/14，A2 归一化代理）。
 * 运行：node --test ops/image-watermark/src/index.test.js
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import worker, {
  landingRedirect,
  logicalPath,
  routeFor,
  shouldWatermark,
  wmTarget,
} from "./index.js";

const ORIGIN = "https://limooo.cn";

test("logicalPath strips the /static prefix (images.limooo.cn style paths)", () => {
  assert.equal(logicalPath("/portfolio/a.webp"), "/portfolio/a.webp");
  assert.equal(logicalPath("/static/portfolio/a.webp"), "/portfolio/a.webp");
  assert.equal(logicalPath("/static/qr-codes/a.png"), "/qr-codes/a.png");
});

test("bare domain redirects to the indexable gallery page; asset paths do not", () => {
  assert.equal(
    landingRedirect(new URL("https://image.limooo.cn/")),
    "https://images.limooo.cn/",
  );
  assert.equal(
    landingRedirect(new URL("https://image.limooo.cn/portfolio/a.webp")),
    "",
  );
});

test("worker returns a permanent redirect for bare-domain requests", async () => {
  const response = await worker.fetch(
    new Request("https://image.limooo.cn/"),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "https://images.limooo.cn/");
});

test("only top-level portfolio png/jpg/jpeg/webp get watermarked; thumbs do not", () => {
  assert.equal(shouldWatermark("/portfolio/a.webp"), true);
  assert.equal(shouldWatermark("/portfolio/a.jpg"), true);
  assert.equal(shouldWatermark("/portfolio/a.png"), true);
  assert.equal(shouldWatermark("/portfolio/thumbs/a.webp"), false);
  assert.equal(shouldWatermark("/qr-codes/a.png"), false);
  assert.equal(shouldWatermark("/icons/a.png"), false);
});

test("portfolio root images always return the watermarked variant", () => {
  const url = new URL("https://image.limooo.cn/portfolio/a.webp");
  const route = routeFor(url, { headers: new Headers() }, ORIGIN);
  assert.equal(route.watermarked, true);
  assert.ok(route.target.startsWith(`${ORIGIN}/static/wm/portfolio/a.webp`));
  assert.ok(route.target.includes("__wmver="));
});

test("thumbs / qr-codes / icons are served clean, unwatermarked", () => {
  const thumb = routeFor(new URL("https://image.limooo.cn/portfolio/thumbs/a.webp"), { headers: new Headers() }, ORIGIN);
  assert.equal(thumb.watermarked, false);
  assert.equal(thumb.target, `${ORIGIN}/static/portfolio/thumbs/a.webp`);

  const qr = routeFor(new URL("https://image.limooo.cn/qr-codes/a.png"), { headers: new Headers() }, ORIGIN);
  assert.equal(qr.watermarked, false);
  assert.equal(qr.target, `${ORIGIN}/static/qr-codes/a.png`);

  const icon = routeFor(new URL("https://image.limooo.cn/icons/Limooo.svg"), { headers: new Headers() }, ORIGIN);
  assert.equal(icon.watermarked, false);
  assert.equal(icon.target, `${ORIGIN}/static/icons/Limooo.svg`);
});

test("/static prefix is compatible: /static/portfolio/a.webp still watermarked", () => {
  const route = routeFor(new URL("https://images.limooo.cn/static/portfolio/a.webp"), { headers: new Headers() }, ORIGIN);
  assert.equal(route.watermarked, true);
  assert.ok(route.target.startsWith(`${ORIGIN}/static/wm/portfolio/a.webp`));
});

test("never proxies /api/* or unknown paths", () => {
  const api = routeFor(new URL("https://image.limooo.cn/api/secret?q=1"), { headers: new Headers() }, ORIGIN);
  assert.equal(api.target, "");
  assert.equal(api.image, false);

  const unknown = routeFor(new URL("https://image.limooo.cn/random/thing"), { headers: new Headers() }, ORIGIN);
  assert.equal(unknown.target, "");
});

test("watermark origin URL hits /static/wm/ with a version param", () => {
  const target = wmTarget(ORIGIN, "/portfolio/a.webp", "?v=1");
  assert.equal(new URL(target).pathname, "/static/wm/portfolio/a.webp");
  assert.ok(target.includes("__wmver=3"));
});
