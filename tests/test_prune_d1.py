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

"""ops/prune_d1.py 的纯函数测试（不连接 Cloudflare，不访问密钥）。"""

from __future__ import annotations

from ops import prune_d1


def test_retention_buckets_are_7_30_90_days() -> None:
    assert prune_d1.BUCKETS["ray_log_v2"] == 7 * 86400
    assert prune_d1.BUCKETS["visitors_v2"] == 30 * 86400
    assert prune_d1.BUCKETS["visitor_rollups"] == 30 * 86400
    assert prune_d1.BUCKETS["events"] == 90 * 86400


def test_aggregate_sql_targets_v2_and_daily() -> None:
    sql = prune_d1._aggregate_sql()
    assert "FROM visitors_v2" in sql
    assert "FROM visitor_rollups" in sql
    assert "INTO visitors_daily" in sql
    assert "ip_hash" in sql


def test_aggregate_upserts_instead_of_replacing() -> None:
    """W7-5：`INSERT OR REPLACE` 会先删掉冲突行，只覆盖部分小时的滚动窗口
    于是把「昨天那一行」的较早小时数永久改小；必须是单调推进的 upsert。"""
    sql = prune_d1._aggregate_sql()
    assert "INSERT OR REPLACE" not in sql
    assert "ON CONFLICT (day, country, page_slug, status) DO UPDATE SET" in sql
    assert "MAX(unique_ips, excluded.unique_ips)" in sql
    assert "MAX(requests, excluded.requests)" in sql


def test_aggregate_daily_does_not_count_entire_daily_table(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(prune_d1, "d1_query", lambda cfg, sql: calls.append(sql) or [])
    monkeypatch.setattr(prune_d1, "_write_retention_state", lambda *args, **kwargs: None)

    assert prune_d1.aggregate_daily({"token": "t", "account_id": "a", "database_id": "d"}) == {
        "visitors_daily": "updated"
    }
    assert not any("COUNT(*) AS count FROM visitors_daily" in sql for sql in calls)


def test_prune_uses_rollup_last_ts_column(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        return [{"count": 0}] if sql.startswith("SELECT COUNT") else []

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)
    monkeypatch.setattr(prune_d1, "_write_retention_state", lambda *args, **kwargs: None)

    prune_d1.prune_buckets({"token": "t", "account_id": "a", "database_id": "d"})

    rollup_calls = [sql for sql in calls if "visitor_rollups" in sql]
    assert any("WHERE last_ts <" in sql for sql in rollup_calls)
    assert not any("visitor_rollups WHERE ts" in sql for sql in rollup_calls)


def test_dry_run_uses_rollup_last_ts_column(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        return [{"count": 0}]

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)

    prune_d1.dry_run({"token": "t", "account_id": "a", "database_id": "d"}, "prune")

    assert any("visitor_rollups" in sql and "WHERE last_ts <" in sql for sql in calls)


def test_dry_run_reports_counts_without_deleting(monkeypatch) -> None:
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        if "FROM visitors_daily" in sql or "SELECT COUNT(*) AS count" in sql:
            return [{"count": 3}]
        return []

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)
    plan = prune_d1.dry_run({"token": "t", "account_id": "a", "database_id": "d"}, "all")
    assert plan["buckets"]["ray_log_v2"] == 3
    assert plan["buckets"]["visitors_v2"] == 3
    assert plan["buckets"]["visitor_rollups"] == 3
    assert plan["buckets"]["events"] == 3
    assert plan["aggregate_rows"] == 3
    # any() would pass as soon as ONE of the statements is not a DELETE, which is
    # exactly what dry-run must guarantee for ALL of them.
    assert all("DELETE" not in sql for sql in calls)


def test_dry_run_only_issues_selects(monkeypatch) -> None:
    """dry-run is the mode operators point at production: it must never mutate."""
    calls: list[str] = []

    def fake_query(cfg, sql: str):
        calls.append(sql)
        return [{"count": 0}]

    monkeypatch.setattr(prune_d1, "d1_query", fake_query)
    for mode in ("all", "prune", "aggregate"):
        prune_d1.dry_run({"token": "t", "account_id": "a", "database_id": "d"}, mode)

    assert calls, "dry_run issued no query at all"
    mutating = [sql for sql in calls if not sql.lstrip().upper().startswith("SELECT")]
    assert not mutating, f"dry_run sent non-SELECT statements: {mutating}"

