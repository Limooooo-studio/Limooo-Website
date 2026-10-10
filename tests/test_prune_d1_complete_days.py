"""docs/22 W7-5 / W7-8: aggregation window + retention owner.

The aggregation table `visitors_daily` must only ever move forward:

  * only **complete UTC days** are aggregated (the current day is still growing);
  * the write is `ON CONFLICT ... DO UPDATE SET x = MAX(x, excluded.x)`, because
    SQLite's `INSERT OR REPLACE` deletes the conflicting row first and a recompute
    that only covers part of a day would shrink counts that were already correct.

The SQL is executed against a real (in-memory) SQLite built from the checked-in
migrations -- no Cloudflare, no credentials, no network.

W7-8: the retention policy owner is `ops/status-worker/src/retention.ts` (the copy
the Worker cron runs). `ops/prune_d1.py` must not be able to drift from it.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from ops import prune_d1

ROOT = Path(__file__).resolve().parents[1]
RETENTION_TS = ROOT / "ops" / "status-worker" / "src" / "retention.ts"
DAY = 86400


def _schema() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    for name in (
        "003_events.sql",
        "005_retention.sql",
        "008_gate_failures.sql",
        "014_visitor_ip_enc.sql",
    ):
        con.executescript((ROOT / "ops" / "migrations" / name).read_text(encoding="utf-8"))
    return con


def test_window_is_complete_utc_days_only() -> None:
    start, end = prune_d1._aggregate_window(7)
    assert end == f"(unixepoch() / {DAY}) * {DAY}", "the window must end at the current UTC midnight"
    assert start == f"{end} - {7 * DAY}", "the window must be a whole number of days back"
    sql = prune_d1._aggregate_sql(7)
    # 旧写法是 `ts >= unixepoch() - 86400`：包含当天、且与整点无关。
    assert "unixepoch() - 86400" not in sql
    assert f"ts >= {start} AND ts < {end}" in sql
    assert f"last_ts >= {start} AND last_ts < {end}" in sql
    count_sql = prune_d1._aggregate_count_sql(7)
    assert f"last_ts >= {start} AND last_ts < {end}" in count_sql


def test_aggregation_never_shrinks_and_skips_the_current_day() -> None:
    con = _schema()
    now = int(time.time())
    today = (now // DAY) * DAY
    yesterday = today - DAY
    two_days_ago = today - 2 * DAY

    con.executemany(
        "INSERT INTO visitors_v2 (id, ip_hash, country, status, ts, page_slug) "
        "VALUES (?,?,?,?,?,?)",
        [
            (1, "h1", "US", 200, yesterday + 3600, "home"),
            (2, "h1", "US", 200, yesterday + 7200, "home"),
            (3, "h2", "JP", 200, two_days_ago + 3600, "home"),
            (4, "h3", "US", 200, today + 60, "home"),  # 当天：不能进聚合表
        ],
    )
    con.execute(
        "INSERT INTO visitor_rollups "
        "(bucket_hour, ip_hash, country, page_slug, status, requests, last_ts) "
        "VALUES (?,?,?,?,?,?,?)",
        (yesterday, "h1", "US", "home", 200, 5, yesterday + 60),
    )
    con.commit()

    sql = prune_d1._aggregate_sql(7)
    con.execute(sql)
    first = {row[0]: row for row in con.execute("SELECT * FROM visitors_daily")}
    yesterday_key = time.strftime("%Y-%m-%d", time.gmtime(yesterday))
    today_key = time.strftime("%Y-%m-%d", time.gmtime(today))
    assert today_key not in first, "the current, still-growing UTC day must not be aggregated"
    assert first[yesterday_key][5] == 7  # 2 detail rows + rollup requests=5
    assert first[yesterday_key][4] == 1  # one distinct ip_hash

    con.execute(sql)  # 幂等
    assert {row[0]: row for row in con.execute("SELECT * FROM visitors_daily")} == first

    # 明细被清理后重算只覆盖一天：旧值只能保持，绝不能变小（INSERT OR REPLACE 会变小）。
    con.execute("DELETE FROM visitors_v2 WHERE ts >= ?", (yesterday,))
    con.execute(
        "INSERT INTO visitors_v2 (id, ip_hash, country, status, ts, page_slug) "
        "VALUES (99,'h9','US',200,?, 'home')",
        (yesterday + 100,),
    )
    con.commit()
    con.execute(sql)
    after = {row[0]: row for row in con.execute("SELECT * FROM visitors_daily")}
    assert after[yesterday_key][5] >= first[yesterday_key][5]
    assert after[yesterday_key][4] >= first[yesterday_key][4]


def test_python_retention_policy_is_read_from_the_owner() -> None:
    buckets, columns = prune_d1.parse_retention_source()
    assert buckets == prune_d1.BUCKETS
    assert columns == prune_d1.RETENTION_TIMESTAMP_COLUMNS
    # owner 是唯一事实源：它必须真的被解析出内容，而不是空集合。
    assert buckets["auth_sessions"] == 60 * DAY
    assert columns["auth_sessions"] == "exp"
    assert len(buckets) == len(prune_d1.BUCKETS) >= 7


def test_drift_from_the_owner_is_fatal(tmp_path: Path) -> None:
    fake = tmp_path / "retention.ts"
    fake.write_text(RETENTION_TS.read_text(encoding="utf-8").replace("90 * DAY_SECONDS", "45 * DAY_SECONDS"), encoding="utf-8")
    with pytest.raises(RuntimeError, match="drifted"):
        prune_d1.verify_retention_matches_owner(fake)
