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

"""D1 query-plan guards for the hot read paths (docs/22 W7-9 + migration 017).

These are regression guards, not a benchmark. They encode two decisions that were
taken against production D1 on 2026-10-11 and would otherwise be easy to undo by
accident:

1. `ray_log_v2` needs `(ip_hash, ts DESC)`. Before migration 017 every
   `WHERE ip_hash = ...` query was `SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts`
   (a full index scan of the 7-day detail table). The guard builds the schema from
   `ops/migrations/*.sql` in an in-memory sqlite3 and asserts that SQLite's own
   planner turns the real query shapes into `SEARCH ... USING <index>`.

2. `ray_log_v2` must NOT get `(host, ts)` back. `005_retention.sql` created it and
   `008_gate_failures.sql` deliberately dropped it because no production query
   filters that table by `host`; it would only amplify every insert.

The plans are produced with `EXPLAIN QUERY PLAN` on a schema-only database, so the
tests are hermetic (no network, no fixtures) and these plan shapes do not depend on
row counts.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "ops" / "migrations"

# 迁移 017 落地的那条索引；名字与列序都是契约的一部分（排序方向显式 DESC）。
RAY_INDEX = "idx_ray_log_v2_ip_hash_ts"
RAY_INDEX_MIGRATION = "017_ray_log_v2_ip_hash_index.sql"

# 005 建、008 刻意删掉，且不该被重新建起来的索引。
DROPPED_RAY_INDEX = "idx_ray_log_v2_host_ts"


def _migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


def _index_names(con: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row[0])
        for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (table,)
        )
    }


def _plan(con: sqlite3.Connection, sql: str) -> str:
    rows = con.execute(f"EXPLAIN QUERY PLAN {sql}").fetchall()
    return " | ".join(str(row[-1]) for row in rows)


def _assert_searches(plan: str, table: str) -> None:
    """断言计划是 SEARCH（而不是 SCAN）。

    SQLite 在索引本身就能满足整个查询时说 `USING COVERING INDEX`，否则说
    `USING INDEX`——两者都是我们要的 SEARCH，所以这里只把「不是 SCAN」钉死；
    具体走了哪个索引由调用方单独断言。
    """
    assert f"SEARCH {table} USING" in plan, plan
    assert f"SCAN {table}" not in plan, plan


@pytest.fixture(scope="module")
def migrated_db() -> Iterator[sqlite3.Connection]:
    """把 ops/migrations/*.sql 按文件名顺序灌进一个内存库（017 之后的状态）。"""
    con = sqlite3.connect(":memory:")
    try:
        for path in _migration_files():
            con.executescript(path.read_text(encoding="utf-8"))
        yield con
    finally:
        con.close()


def test_index_migration_017_exists_and_is_the_highest_number() -> None:
    """017 必须存在；以后新增索引要走更大的编号（005 改不动，见文件头注释）。"""
    assert (MIGRATIONS_DIR / RAY_INDEX_MIGRATION).is_file()
    numbers = [int(p.name[:3]) for p in _migration_files()]
    assert max(numbers) >= 17


def test_index_migration_is_idempotent() -> None:
    """`CREATE INDEX IF NOT EXISTS` 意味着这份迁移可以重复执行。

    migrate_d1.sh 依赖这一点：如果记账行丢了而 schema 已在，它会重跑该文件。
    所以新迁移不得写裸 `CREATE INDEX`（重复执行会 `index already exists` 报错）。
    """
    source = (MIGRATIONS_DIR / RAY_INDEX_MIGRATION).read_text(encoding="utf-8")
    assert f"CREATE INDEX IF NOT EXISTS {RAY_INDEX}" in source
    bare = [
        line
        for line in source.splitlines()
        if re.match(r"\s*CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)", line, re.IGNORECASE)
    ]
    assert not bare, "new migrations must use CREATE INDEX IF NOT EXISTS: " + "; ".join(bare)

    # 真的重复执行三次：第二次起必须是无操作，而不是报错。
    con = sqlite3.connect(":memory:")
    try:
        for path in _migration_files():
            con.executescript(path.read_text(encoding="utf-8"))
        for _ in range(3):
            con.executescript(source)
        assert RAY_INDEX in _index_names(con, "ray_log_v2")
    finally:
        con.close()


def test_ip_hash_index_exists_with_expected_columns(migrated_db: sqlite3.Connection) -> None:
    """索引真的建在 (ip_hash, ts) 上（不是只写在注释里、也没建错列）。"""
    assert RAY_INDEX in _index_names(migrated_db, "ray_log_v2")
    columns = [str(row[2]) for row in migrated_db.execute(f'PRAGMA index_info("{RAY_INDEX}")')]
    assert columns == ["ip_hash", "ts"], f"unexpected index columns: {columns}"


def test_check_visitor_id_query_uses_the_index(migrated_db: sqlite3.Connection) -> None:
    """ops/check_visitor_id.py:212 —— `WHERE ip_hash = ? ORDER BY ts DESC LIMIT n`。"""
    plan = _plan(
        migrated_db,
        "SELECT ts, host, normalized_path, method, status, country, ua_family "
        "FROM ray_log_v2 WHERE ip_hash = 'd51153cb767fc758' ORDER BY ts DESC LIMIT 10",
    )
    _assert_searches(plan, "ray_log_v2")
    assert RAY_INDEX in plan, plan
    assert "TEMP B-TREE" not in plan, plan


def test_check_ip_rays_query_uses_the_index(migrated_db: sqlite3.Connection) -> None:
    """ops/check_ip_rays.py:168 —— `WHERE ip_hash IN (...) ORDER BY ts DESC LIMIT n`。

    这正是 W7-9 记录的「必然全表扫」那条。`IN` 有多个值时 SQLite 可能为合并
    有序结果再建一个临时 B-tree，但**扫表**必须消失。
    """
    plan = _plan(
        migrated_db,
        "SELECT ray, ts, host, normalized_path AS path, method, status, country, ip_hash, duration_ms "
        "FROM ray_log_v2 WHERE ip_hash IN ('d51153cb767fc758','0000000000000000') "
        "ORDER BY ts DESC LIMIT 20",
    )
    _assert_searches(plan, "ray_log_v2")
    assert RAY_INDEX in plan, plan


def test_ray_prefix_query_searches_the_primary_key(migrated_db: sqlite3.Connection) -> None:
    """ray 前缀查必须走**主键 seek**，不能再退化成全扫。

    历史：`WHERE ray LIKE '<id>%'` 时 SQLite 用不上 PRIMARY KEY，计划是
    `SCAN ray_log_v2 USING INDEX idx_ray_log_v2_ts`（2026-10-11 实测线上全扫）。
    落库值带 colo 后缀（`a48923a17e543777-LAX`），所以前缀匹配是**有意**的，
    不能改成等值；改成主键范围后计划变成
    `SEARCH ray_log_v2 USING COVERING INDEX sqlite_autoindex_ray_log_v2_1 (ray>? AND ray<?)`。

    这条测试钉住优化后的形状：有人把它改回 `LIKE` 就红。同时也说明为什么**不该**
    期待它走 `idx_ray_log_v2_ip_hash_ts`——前缀约束的是主键，不是 ip_hash。
    """
    plan = _plan(
        migrated_db,
        "SELECT ip_hash, country FROM ray_log_v2 "
        "WHERE ray >= '9a1b2c3d4e5f6a7b' AND ray < '9a1b2c3d4e5f6a7b' || char(1114111) "
        "ORDER BY ts DESC LIMIT 100",
    )
    # 断言实质而不是逐字：必须 `SEARCH`（不是 `SCAN`）、走主键自动索引、且两个边界都被约束。
    # 是否 `COVERING` 取决于 select 列表（取 `ip_hash`/`country` 要回表），不该写死。
    assert "SEARCH ray_log_v2 USING" in plan and "SCAN" not in plan, plan
    assert "sqlite_autoindex_ray_log_v2_1" in plan, plan
    assert "(ray>? AND ray<?)" in plan, plan


def test_no_query_uses_ray_like_on_the_log_tables() -> None:
    """源码里不得再出现 `ray LIKE` / `request_id LIKE` ——它们会全扫。

    与上一条互补：上一条钉的是 SQL 形状（在内存库里），这一条钉的是**仓库源码**，
    防止有人在 `functions/` 或 `ops/` 里新写一条 LIKE 反查又把全扫带回来。
    """
    offenders: list[str] = []
    for directory in ("functions", "ops"):
        base = ROOT / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix not in (".ts", ".py", ".js") or not path.is_file():
                continue
            if any(part in ("node_modules", "__pycache__", "__mocks__") for part in path.parts):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            for lineno, line in enumerate(text.splitlines(), 1):
                if line.lstrip().startswith(("#", "//", "*")):
                    continue
                if re.search(r"\b(ray|request_id)\s+LIKE\b", line, re.IGNORECASE):
                    offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()[:80]}")
    assert offenders == [], "prefix lookups must use a range, not LIKE:\n" + "\n".join(offenders)


def test_no_query_filters_ray_log_v2_by_host() -> None:
    """`host` 索引被 008 删掉的前提是「没有查询按 host 过滤 ray_log_v2」。

    这条断言把这个前提钉住：哪天真的出现按 host 过滤 ray_log_v2 的查询，它会红，
    提醒重估是否需要 (host, ts) 索引——而不是悄悄漏掉该有的索引。
    """
    offenders: list[str] = []
    for directory in ("functions", "ops", "src"):
        base = ROOT / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix not in (".ts", ".py", ".js") or not path.is_file():
                continue
            if any(part in ("node_modules", "__pycache__", "__mocks__") for part in path.parts):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if "ray_log_v2" not in text:
                continue
            rel = path.relative_to(ROOT).as_posix()
            for line in text.splitlines():
                lowered = line.lower()
                if "ray_log_v2" not in lowered:
                    continue
                if "where" not in lowered:
                    continue
                if re.search(r"\bhost\s*(=|IN\b|LIKE\b|GLOB\b|>=|<=|<|>)", lowered):
                    offenders.append(f"{rel}: {line.strip()}")
    assert not offenders, (
        "a query now filters ray_log_v2 by host; re-evaluate idx_ray_log_v2_host_ts "
        "(dropped on purpose by 008_gate_failures.sql):\n  " + "\n  ".join(offenders)
    )


def test_host_index_is_not_reintroduced(migrated_db: sqlite3.Connection) -> None:
    """(host, ts) 索引不得被 008 之后的任何迁移重新建起来。

    005 建它、008 删它都是历史事实（文件名不能改），所以这里只禁止**新增**：
    008 之后的迁移里出现 `CREATE INDEX ... idx_ray_log_v2_host_ts` 即失败，
    同时最终 schema 里它必须不存在。
    """
    cutoff = 8
    offenders: list[str] = []
    for path in _migration_files():
        if int(path.name[:3]) <= cutoff:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if DROPPED_RAY_INDEX in line and line.strip().upper().startswith("CREATE"):
                offenders.append(f"{path.name}: {line.strip()}")
    assert not offenders, (
        "008_gate_failures.sql dropped idx_ray_log_v2_host_ts because no production query "
        "uses it and it amplifies every write; do not re-add it:\n  " + "\n  ".join(offenders)
    )
    assert DROPPED_RAY_INDEX not in _index_names(migrated_db, "ray_log_v2")


def test_visitor_rollups_lookup_is_indexed(migrated_db: sqlite3.Connection) -> None:
    """visitor_rollups 侧不需要新索引：按 ip_hash 取行已经在走 014 建的索引。

    `ops/check_ip_rays.py:127`、`check_visitor_id.py:135/168` 都是「按 ip_hash
    取单行/最近一行」的形状，必须是 SEARCH 而不是扫表。
    """
    plan = _plan(
        migrated_db,
        "SELECT ip_enc, last_ts FROM visitor_rollups WHERE ip_hash = 'd51153cb767fc758' "
        "AND ip_enc != '' ORDER BY last_ts DESC LIMIT 1",
    )
    _assert_searches(plan, "visitor_rollups")
    assert "idx_visitor_rollups_ip_hash" in plan, plan
