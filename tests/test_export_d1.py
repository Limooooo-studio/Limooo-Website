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

"""ops/export_d1.py 的 blocklist 导出测试（docs/10）。"""

import ops.export_d1 as export_d1


def test_export_blocklist_uses_new_schema(tmp_path, monkeypatch):
    source = tmp_path / "blocklist.txt"
    source.write_text("1.2.3.4\n2001:db8::1/64\n", encoding="utf-8")
    out_dir = tmp_path / "out"
    monkeypatch.setattr(export_d1, "OUT_DIR", str(out_dir))

    assert export_d1.export_blocklist(str(source)) == 0
    sql = (out_dir / "blocklist.sql").read_text(encoding="utf-8")
    assert "INSERT OR IGNORE INTO blocked_ips" in sql
    assert "network" in sql and "prefix" in sql
    assert "1.2.3.4/32" in sql
    assert "2001:db8::/64" in sql
    assert "active" in sql
