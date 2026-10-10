# Limooo - serverless personal website and admin system
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""src/cidr.py 统一 IP/CIDR 规范化测试（docs/10）。"""

import json
from pathlib import Path

import cidr

# 与 functions/_lib/cidr.test.ts 共用的同一份向量：两边都必须复现 CPython
# ipaddress 的 canonical 形式，否则 blocked_ips 的字符串等值比较两端不一致。
PARITY = json.loads((Path(__file__).parent / "fixtures" / "cidr_parity.json").read_text())


def test_normalize_ip():
    assert cidr.normalize_ip("1.2.3.4") == "1.2.3.4"
    assert cidr.normalize_ip("2001:0db8:0:0:0:0:0:1") == "2001:db8::1"
    assert cidr.normalize_ip("2001:db8::1") == "2001:db8::1"
    assert cidr.normalize_ip("999.1.1.1") is None
    assert cidr.normalize_ip("2001:::1") is None


def test_parse_and_normalize_cidr():
    assert cidr.parse_cidr("1.2.3") == ("1.2.3.0", 24)
    assert cidr.parse_cidr("1.2.3.4") == ("1.2.3.4", 32)
    assert cidr.parse_cidr("1.2.3.0/24") == ("1.2.3.0", 24)
    assert cidr.parse_cidr("2001:db8::1/64") == ("2001:db8::", 64)
    assert cidr.normalize_cidr("2001:0db8:0:0:0:0:0:1/64") == "2001:db8::/64"
    assert cidr.normalize_cidr("# comment") is None
    assert cidr.normalize_cidr("1.2.3.4/33") is None


def test_network_and_contains():
    assert cidr.network_address("1.2.3.4", 24) == "1.2.3.0"
    assert cidr.network_address("2001:db8::1", 64) == "2001:db8::"
    assert cidr.cidr_contains("2001:db8::/64", "2001:db8::1") is True
    assert cidr.cidr_contains("2001:db8::/64", "2001:db9::1") is False
    assert cidr.cidr_contains("1.2.3.0/24", "1.2.3.9") is True
    assert cidr.cidr_contains("bad", "1.2.3.4") is False


def test_ipv4_mapped_ipv6_uses_dotted_quad():
    """W9-2：mapped 地址必须与 Worker 侧产出逐字符相同，否则封禁永不命中。"""
    assert cidr.normalize_ip("::ffff:1.2.3.4") == "::ffff:1.2.3.4"
    assert cidr.normalize_ip("::FFFF:1.2.3.4") == "::ffff:1.2.3.4"
    # ::ffff:0:1.2.3.4 不是 IPv4-mapped（第 6 组是 0000），CPython 用 hex 组。
    assert cidr.normalize_ip("::ffff:0:1.2.3.4") == "::ffff:0:102:304"
    assert cidr.normalize_cidr("::ffff:1.2.3.4") == "::ffff:1.2.3.4/128"
    assert cidr.network_address("::ffff:1.2.3.4", 96) == "::ffff:0.0.0.0"


def test_matches_cpython_oracle_for_shared_parity_vectors():
    import ipaddress

    for case in PARITY["normalize"]:
        expected = ipaddress.ip_address(case["input"]).compressed
        assert expected == case["expected"], f"fixture drifted for {case['input']}"
        assert cidr.normalize_ip(case["input"]) == case["expected"]
    for case in PARITY["cidr"]:
        network = ipaddress.ip_network(case["input"], strict=False)
        assert str(network.network_address) == case["expected_network"]
        assert network.prefixlen == case["expected_prefix"]
        assert cidr.parse_cidr(case["input"]) == (
            case["expected_network"],
            case["expected_prefix"],
        )
        assert cidr.normalize_cidr(case["input"]) == (
            f"{case['expected_network']}/{case['expected_prefix']}"
        )

