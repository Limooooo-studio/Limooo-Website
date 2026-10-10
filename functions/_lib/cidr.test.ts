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

/** IPv4/IPv6 规范化与匹配测试（docs/10）。 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalCidr,
  contains,
  networkAddress,
  normalizeIp,
  parseCidr,
} from "./cidr";

/**
 * 两端（TS `functions/_lib/cidr.ts` / Python `src/cidr.py`）共用的一致性向量。
 *
 * `expected_*` 是 CPython `ipaddress` 的输出：封禁表 `blocked_ips(network, prefix)`
 * 是**字符串等值**比较，只要两端规范化结果不同，Python 写进去的封禁行就永远
 * 匹配不上 Worker 生成的候选，封禁静默失效（fail-open）。
 */
const PARITY = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../tests/fixtures/cidr_parity.json", import.meta.url)),
    "utf8",
  ),
) as {
  normalize: Array<{ input: string; expected: string }>;
  cidr: Array<{ input: string; expected_network: string; expected_prefix: number }>;
};

describe("cidr", () => {
  it("normalizes IPv4 and IPv6 addresses", () => {
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("2001:::1")).toBeNull();
  });

  it("parses and canonicalizes CIDRs", () => {
    expect(parseCidr("1.2.3")).toEqual({
      network: "1.2.3.0",
      prefix: 24,
      cidr: "1.2.3.0/24",
      version: 4,
    });
    expect(parseCidr("1.2.3.4")).toEqual({
      network: "1.2.3.4",
      prefix: 32,
      cidr: "1.2.3.4/32",
      version: 4,
    });
    expect(parseCidr("2001:db8::1/64")).toEqual({
      network: "2001:db8::",
      prefix: 64,
      cidr: "2001:db8::/64",
      version: 6,
    });
    expect(canonicalCidr("2001:0db8:0:0:0:0:0:1/64")).toBe("2001:db8::/64");
  });

  it("computes network addresses and matching", () => {
    expect(networkAddress("1.2.3.4", 24)).toBe("1.2.3.0");
    expect(networkAddress("2001:db8::1", 64)).toBe("2001:db8::");
    expect(contains("2001:db8::", 64, "2001:db8::1")).toBe(true);
    expect(contains("2001:db8::", 64, "2001:db9::1")).toBe(false);
    expect(contains("1.2.3.0", 24, "1.2.3.9")).toBe(true);
  });

  it("rejects invalid prefixes", () => {
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("2001:db8::1/129")).toBeNull();
  });

  it("renders IPv4-mapped IPv6 in CPython's dotted-quad form", () => {
    // 回归：以前输出 ::ffff:102:304，与 Python 侧的 ::ffff:1.2.3.4 不同，
    // blocked_ips 的字符串等值比较永远不命中 —— 封禁静默变 no-op。
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(normalizeIp("::FFFF:1.2.3.4")).toBe("::ffff:1.2.3.4");
    // 只有前 80 位为 0 且第 6 组为 ffff 的地址才算 IPv4-mapped：
    // ::ffff:0:1.2.3.4 的字节是 ...:0000:ffff:0000:0102:0304，CPython 用 hex 组。
    expect(normalizeIp("::ffff:0:1.2.3.4")).toBe("::ffff:0:102:304");
    // NAT64 前缀不是 IPv4-mapped，保持 hex。
    expect(normalizeIp("64:ff9b::1.2.3.4")).toBe("64:ff9b::102:304");
  });

  it("matches CPython ipaddress for every shared parity vector", () => {
    for (const { input, expected } of PARITY.normalize) {
      expect(normalizeIp(input), `normalizeIp(${input})`).toBe(expected);
    }
    for (const { input, expected_network, expected_prefix } of PARITY.cidr) {
      const parsed = parseCidr(input);
      expect(parsed, `parseCidr(${input})`).not.toBeNull();
      expect(parsed!.network, `network(${input})`).toBe(expected_network);
      expect(parsed!.prefix, `prefix(${input})`).toBe(expected_prefix);
      expect(parsed!.cidr).toBe(`${expected_network}/${expected_prefix}`);
      expect(canonicalCidr(input)).toBe(`${expected_network}/${expected_prefix}`);
    }
  });

  it("keeps a Python-written ::ffff ban row matchable", () => {
    // 端到端语义：Python 侧用 normalize_cidr("::ffff:1.2.3.4") 写入 blocked_ips 的
    // network 是 "::ffff:1.2.3.4"；Worker 必须为同一个访客 IP 推出同样的候选串。
    expect(parseCidr("::ffff:1.2.3.4")).toEqual({
      network: "::ffff:1.2.3.4",
      prefix: 128,
      cidr: "::ffff:1.2.3.4/128",
      version: 6,
    });
    expect(networkAddress("::ffff:1.2.3.4", 128)).toBe("::ffff:1.2.3.4");
    expect(networkAddress("::ffff:1.2.3.4", 96)).toBe("::ffff:0.0.0.0");
    expect(networkAddress("::ffff:1.2.3.4", 120)).toBe("::ffff:1.2.3.0");
  });
});
