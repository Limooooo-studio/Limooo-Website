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

"""config 工具函数与 geo_cache 建表测试。"""

import sqlite3

from config import ensure_geo_cache, get_cached_geo, is_private_ip


def test_ip_ranges():
    assert is_private_ip("127.0.0.1") is True
    assert is_private_ip("192.168.1.1") is True
    assert is_private_ip("10.0.0.1") is True
    assert is_private_ip("8.8.8.8") is False


def test_ensure_geo_cache_and_read(tmp_path):
    conn = sqlite3.connect(tmp_path / "geo.db")
    ensure_geo_cache(conn)
    conn.execute(
        "INSERT INTO geo_cache (ip, country, city, latitude, longitude, isp, asn) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("8.8.8.8", "US", "Mountain View", 37.4, -122.0, "Google", "AS15169"),
    )
    conn.commit()
    row = get_cached_geo(conn, "8.8.8.8")
    assert row and row["country"] == "US" and row["asn"] == "AS15169"
    conn.close()
