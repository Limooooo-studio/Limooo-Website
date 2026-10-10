import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Workers 内置模块，Node 侧没有实现；用桩顶上才能加载 status-worker 的测试。
      "cloudflare:sockets": fileURLToPath(
        new URL("./ops/status-worker/src/__mocks__/cloudflare-sockets.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Silence the tests' console output. Measured 2026-10-11: a clean run printed 437 lines of
    // which 257 (59%) were the product's own structured event logs — `functions/_lib/logging.ts`
    // and the Workers under `ops/` emit one single-line JSON event each, and the Worker tests
    // call the real `scheduled()`. During a failed `ops/deploy.sh` check those lines buried the
    // failing assertion, so finding it took hand-filtering the log.
    //
    // Only `true` works here: `silent: "passed"` left 225 of the 257 lines (and additionally
    // dropped the logs of the failing tests), and an `onConsoleLog` filter only removed the
    // prefixed ones, because direct `console.log` calls bypass that hook.
    //
    // Trade-off: console output is hidden for failing tests too. Re-run without it when you need
    // the logs:  npx vitest run --silent=false
    silent: true,
    include: [
      "functions/**/*.test.ts",
      "ops/sync-worker/src/**/*.test.ts",
      "ops/d1-archive/src/**/*.test.ts",
      "ops/status-worker/src/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.venv-build/**",
    ],
  },
});
