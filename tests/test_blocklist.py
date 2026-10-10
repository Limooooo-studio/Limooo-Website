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

"""封禁名单解析与 D1 同步测试（Nginx 扫描部分已随 VPS 退租删除）。"""

import auto_block


def test_normalize_cidr():
    assert auto_block._normalize_cidr("1.2.3") == "1.2.3.0/24"
    assert auto_block._normalize_cidr("1.2.3.0/24") == "1.2.3.0/24"
    assert auto_block._normalize_cidr("1.2.3.4") == "1.2.3.4/32"
    assert auto_block._normalize_cidr("2001:db8::1/64") == "2001:db8::/64"
    assert auto_block._normalize_cidr("# comment") is None


def test_read_blocklist_txt(tmp_path):
    p = tmp_path / "blocklist.txt"
    p.write_text(
        "# header\n\n"
        "1.2.3.0/24\n"
        "4.5.6.7/32\n",
        encoding="utf-8",
    )
    static, prefixes = auto_block.read_blocklist_txt(str(p))
    assert static == ["# header", "", "4.5.6.7/32"]
    assert prefixes == {"1.2.3"}


def test_read_blocklist_returns_canonical_cidrs(tmp_path):
    p = tmp_path / "blocklist.txt"
    p.write_text(
        "# header\n1.2.3.4\n1.2.3.0/24\n2001:db8::1/64\nbad\n",
        encoding="utf-8",
    )
    assert auto_block.read_blocklist(str(p)) == [
        "1.2.3.4/32",
        "1.2.3.0/24",
        "2001:db8::/64",
    ]


def _fake_d1_call(calls):
    def fake_call(token, method, url, body=None):
        calls.append((method, url, body))
        sql = (body or {}).get("sql", "")
        if sql.startswith("SELECT"):
            return {
                "result": [
                    {
                        "results": [
                            {
                                "cidr": "1.2.3.0/24",
                                "network": "1.2.3.0",
                                "prefix": 24,
                                "source": "auto_block",
                                "active": 1,
                            },
                            {
                                "cidr": "4.5.6.0/24",
                                "network": "4.5.6.0",
                                "prefix": 24,
                                "source": "auto_block",
                                "active": 1,
                            },
                        ],
                        "meta": {"changes": 0},
                    }
                ]
            }
        return {"result": [{"meta": {"changes": 1}}]}

    return fake_call


def test_sync_d1_dry_run_does_not_write(monkeypatch, tmp_path):
    p = tmp_path / "blocklist.txt"
    p.write_text("1.2.3.0/24\n2001:db8::/64\n", encoding="utf-8")
    monkeypatch.setattr(auto_block, "BLOCKLIST_TXT", str(p))
    monkeypatch.setattr(auto_block, "load_env", lambda path: {
        "CLOUDFLARE_API_TOKEN": "token",
        "CLOUDFLARE_ACCOUNT_ID": "account",
        "D1_DATABASE_ID": "db",
    })
    calls = []
    monkeypatch.setattr(auto_block, "_call", _fake_d1_call(calls))
    assert auto_block.sync_d1(dry_run=True) == 0
    assert not any("INSERT" in body["sql"] or "DELETE" in body["sql"] for _, _, body in calls)
