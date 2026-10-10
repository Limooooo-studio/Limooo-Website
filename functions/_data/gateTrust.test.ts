/**
 * docs/22 W4-4：`functions/_data/gateTrust.ts` 只应带运行时会消费的字段。
 *
 * 320 条低风险 ASN 在运行时零消费（`GATE_TRUST.verified_bot`、`GATE_TRUST_IPS`、
 * `GATE_TRUST_NETWORKS` 才有人读），ASN 的真实消费方是 WAF 的 js_challenge 规则。
 * 这里把生成物钉成契约：一旦有人把 ASN 塞回 isolate，测试直接红。
 */

import { describe, expect, it } from "vitest";
import { GATE_TRUST, GATE_TRUST_IPS, GATE_TRUST_NETWORKS } from "./gateTrust";

describe("gateTrust runtime payload", () => {
  it("only carries what the runtime reads", () => {
    expect(Object.keys(GATE_TRUST).sort()).toEqual([
      "ip_cidrs",
      "ua_allowlist_enabled",
      "verified_bot",
    ]);
  });

  it("does not carry the low-risk ASN list anymore", () => {
    expect("low_risk_asns" in GATE_TRUST).toBe(false);
  });

  it("keeps the fully allowed IPs usable", () => {
    expect(GATE_TRUST_IPS.size).toBe(GATE_TRUST_NETWORKS.length);
    expect(GATE_TRUST_IPS.size).toBeGreaterThan(0);
    for (const ip of GATE_TRUST_IPS) {
      expect(typeof ip).toBe("string");
      expect(ip.length).toBeGreaterThan(0);
    }
    for (const [network, prefix] of GATE_TRUST_NETWORKS) {
      expect(GATE_TRUST_IPS.has(network)).toBe(true);
      expect(Number.isInteger(prefix)).toBe(true);
    }
  });
});
