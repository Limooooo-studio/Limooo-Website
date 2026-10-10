#!/usr/bin/env python3

"""Limooo D1 保留期与每日聚合脚本（docs/11）。

默认只做 dry-run，不删除任何数据；只有显式传入 --apply 才执行聚合与清理。
运行方式（示例，均为生产动作，执行前需在 docs/parallel-actions.md 登记）：

    python3 ops/prune_d1.py --mode all          # 只读：统计与计划
    python3 ops/prune_d1.py --mode aggregate --apply   # 聚合 visitors_daily
    python3 ops/prune_d1.py --mode prune --apply       # 按保留期清理旧数据

保留期的 **owner 是 `ops/status-worker/src/retention.ts`**（每天 03:47 由 Worker
cron 调度的那一份，readme_facts.py 也只解析它）。本文件在导入时逐条与它比对，
不一致直接报错——2026-10-11 之前这里另写了一份 4 张表的策略，与 owner 的 7 张表
漂移（docs/22 W7-8），从那时起不再允许两份并存：

    ray_log_v2  7 天
    visitors_v2 / visitor_rollups / heartbeats 30 天
    auth_sessions 60 天
    events / probe_uptime_daily 90 天
    visitors_daily 永久（按天聚合，只聚合完整的 UTC 天）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ops"))
sys.path.insert(0, str(ROOT / "src"))

from config import ENV_FILE  # noqa: E402

from d1_client import cloudflare_config, d1_query, load_env  # noqa: E402

DAY_SECONDS = 86400
RETENTION_TS = ROOT / "ops" / "status-worker" / "src" / "retention.ts"
# 聚合窗口：只碰**完整的 UTC 天**（不含当天，当天还没走完）。
AGGREGATE_COMPLETE_DAYS = 7

# 下表必须与 owner 的 retention.ts 逐条一致，导入时由 verify_retention_matches_owner()
# 强制校验；字面量保留是为了让生效窗口一眼可见，并让 tests/test_d1_schema.py 能从
# 源码里读出表名（数值本身以 owner 为准，漂移即失败）。
BUCKETS: dict[str, int] = {
    "ray_log_v2": 7 * DAY_SECONDS,
    "visitors_v2": 30 * DAY_SECONDS,
    "visitor_rollups": 30 * DAY_SECONDS,
    "events": 90 * DAY_SECONDS,
    "heartbeats": 30 * DAY_SECONDS,
    "probe_uptime_daily": 90 * DAY_SECONDS,
    "auth_sessions": 60 * DAY_SECONDS,
}
RETENTION_TIMESTAMP_COLUMNS: dict[str, str] = {
    "visitor_rollups": "last_ts",
    "probe_uptime_daily": "day",
    "auth_sessions": "exp",
}


def parse_retention_source(path: Path | str = RETENTION_TS) -> tuple[dict[str, int], dict[str, str]]:
    """从 owner 的 TS 源码现读 (表 → 保留秒数, 表 → 时间戳列)。

    语法解析失败直接抛错：宁可让脚本停下来，也不退回本文件里的副本。
    """
    source = Path(path)
    text = source.read_text(encoding="utf-8")
    block = re.search(r"export const BUCKETS[^=]*=\s*\{(.*?)\n\};", text, re.S)
    if not block:
        raise RuntimeError(f"cannot read BUCKETS out of {source}")
    buckets = {
        name: int(days) * DAY_SECONDS
        for name, days in re.findall(r"(\w+):\s*(\d+)\s*\*\s*DAY_SECONDS", block.group(1))
    }
    if not buckets:
        raise RuntimeError(f"parsed an empty BUCKETS out of {source}")
    columns_block = re.search(r"export const TIMESTAMP_COLUMNS[^=]*=\s*\{(.*?)\n\};", text, re.S)
    columns = (
        dict(re.findall(r"(\w+):\s*\"(\w+)\"", columns_block.group(1))) if columns_block else {}
    )
    return buckets, columns


def verify_retention_matches_owner(path: Path | str = RETENTION_TS) -> None:
    """owner 一旦变化就立刻报错，杜绝「两份保留策略各说各话」。"""
    buckets, columns = parse_retention_source(path)
    if BUCKETS != buckets:
        raise RuntimeError(
            "retention policy drifted from ops/status-worker/src/retention.ts "
            f"(owner): python={BUCKETS} owner={buckets}"
        )
    if RETENTION_TIMESTAMP_COLUMNS != columns:
        raise RuntimeError(
            "retention timestamp columns drifted from ops/status-worker/src/retention.ts "
            f"(owner): python={RETENTION_TIMESTAMP_COLUMNS} owner={columns}"
        )


verify_retention_matches_owner()


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _count_rows(cfg: dict[str, str], table: str, cutoff: int) -> int:
    timestamp_column = RETENTION_TIMESTAMP_COLUMNS.get(table, "ts")
    rows = d1_query(
        cfg,
        f"SELECT COUNT(*) AS count FROM {table} WHERE {timestamp_column} < {cutoff}",
    )
    return int(rows[0].get("count") or 0) if rows else 0


def _day_start_expr() -> str:
    """当前 UTC 零点（把 unixepoch() 向下取整到 86400 的整数倍）。"""
    return f"(unixepoch() / {DAY_SECONDS}) * {DAY_SECONDS}"


def _aggregate_window(days: int = AGGREGATE_COMPLETE_DAYS) -> tuple[str, str]:
    """(窗口下界, 窗口上界)：只覆盖**完整的 UTC 天**，不含当天。"""
    return f"{_day_start_expr()} - {int(days) * DAY_SECONDS}", _day_start_expr()


def _aggregate_sql(days: int = AGGREGATE_COMPLETE_DAYS) -> str:
    """把旧明细与小时汇总合并进 visitors_daily（可重复执行）。

    两个要点（docs/22 W7-5）：

    1. 只聚合**完整的 UTC 天**：`[day_start - days*86400, day_start)`。此前用的是
       滚动 24h 窗口，会把「昨天那一行」用只覆盖部分小时的数据重算。
    2. 写入用 `ON CONFLICT ... DO UPDATE SET x = MAX(x, excluded.x)`，与
       `ops/migrations/013_backfill_probe_uptime.sql` 同一写法。SQLite 的
       `INSERT OR REPLACE` 会先删掉冲突行再插入，于是较早的小时数被永久覆盖；
       MAX 让重复执行只会单调推进，绝不会把已经算进去的计数改小。
    """
    start, end = _aggregate_window(days)
    return (
        "INSERT INTO visitors_daily "
        "(day, country, page_slug, status, unique_ips, requests) "
        "WITH combined AS ("
        "SELECT ts, ip_hash, country, page_slug, status, 1 AS requests, "
        "'v:' || id AS fallback_id FROM visitors_v2 "
        f"WHERE ts >= {start} AND ts < {end} UNION ALL "
        "SELECT last_ts AS ts, ip_hash, country, page_slug, status, requests, "
        "'r:' || bucket_hour || ':' || country || ':' || status || ':' || page_slug AS fallback_id "
        "FROM visitor_rollups "
        f"WHERE last_ts >= {start} AND last_ts < {end}) "
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch'), country, page_slug, status, "
        "COUNT(DISTINCT CASE WHEN ip_hash <> '' THEN ip_hash ELSE fallback_id END), SUM(requests) "
        "FROM combined "
        "GROUP BY strftime('%Y-%m-%d', ts, 'unixepoch'), country, page_slug, status "
        "ON CONFLICT (day, country, page_slug, status) DO UPDATE SET "
        "unique_ips = MAX(unique_ips, excluded.unique_ips), "
        "requests = MAX(requests, excluded.requests)"
    )


def _aggregate_count_sql(days: int = AGGREGATE_COMPLETE_DAYS) -> str:
    start, end = _aggregate_window(days)
    return (
        "SELECT COUNT(*) AS count FROM ("
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch') AS day, country, page_slug, status "
        "FROM (SELECT ts, country, page_slug, status FROM visitors_v2 "
        f"WHERE ts >= {start} AND ts < {end} UNION ALL "
        "SELECT last_ts AS ts, country, page_slug, status FROM visitor_rollups "
        f"WHERE last_ts >= {start} AND last_ts < {end}) "
        "GROUP BY day, country, page_slug, status)"
    )


def _write_retention_state(
    cfg: dict[str, str],
    name: str,
    *,
    success: bool,
    deleted: int = 0,
    error: str = "",
) -> None:
    message = f"bucket={name};deleted={deleted}" if success else f"bucket={name};error={error}"
    now = "unixepoch()"
    state = (
        "INSERT OR REPLACE INTO retention_state "
        "(name, last_run_at, last_success_at, last_error) "
        f"VALUES ({_quote(name)}, {now}, "
        f"{now if success else 0}, {_quote(error)})"
    )
    d1_query(cfg, state)
    event = (
        "INSERT INTO events "
        "(event, ts, request_id, host, path, method, status, outcome, ip_hash, "
        "country, duration_ms, message) "
        f"VALUES ('prune_result', {now}, '', 'ops', '/retention', 'run', "
        f"{200 if success else 500}, '{'ok' if success else 'failed'}', '', '', 0, "
        f"{_quote(message)})"
    )
    d1_query(cfg, event)


def aggregate_daily(cfg: dict[str, str], days: int = AGGREGATE_COMPLETE_DAYS) -> dict[str, Any]:
    """把最近若干个**完整 UTC 天**重新聚合进 visitors_daily（幂等、只增不减）。

    保留策略的 owner 是 Worker 的 `retention.ts`（cron 每天调度）；本脚本是
    运维侧的手动入口，两者读同一份窗口定义（见模块 docstring）。
    """
    d1_query(cfg, _aggregate_sql(days))
    _write_retention_state(cfg, "visitors_daily", success=True)
    return {"visitors_daily": "updated"}


def prune_buckets(cfg: dict[str, str]) -> dict[str, Any]:
    """按保留期清理 v2 表、探针明细、会话与 events，并记录 retention_state。"""
    result: dict[str, int] = {}
    now = "unixepoch()"
    for table, seconds in BUCKETS.items():
        cutoff_expr = f"{now} - {seconds}"
        timestamp_column = RETENTION_TIMESTAMP_COLUMNS.get(table, "ts")
        rows = d1_query(
            cfg,
            f"SELECT COUNT(*) AS count FROM {table} "
            f"WHERE {timestamp_column} < {cutoff_expr}",
        )
        count = int(rows[0].get("count") or 0) if rows else 0
        d1_query(cfg, f"DELETE FROM {table} WHERE {timestamp_column} < {cutoff_expr}")
        _write_retention_state(cfg, table, success=True, deleted=count)
        result[table] = count
    return result


def dry_run(cfg: dict[str, str], mode: str, days: int = AGGREGATE_COMPLETE_DAYS) -> dict[str, Any]:
    """只读统计：不建表、不写状态、不删除。"""
    plan: dict[str, Any] = {"mode": mode, "buckets": {}}
    if mode in ("all", "prune"):
        for table, seconds in BUCKETS.items():
            timestamp_column = RETENTION_TIMESTAMP_COLUMNS.get(table, "ts")
            rows = d1_query(
                cfg,
                f"SELECT COUNT(*) AS count FROM {table} "
                f"WHERE {timestamp_column} < unixepoch() - {seconds}",
            )
            plan["buckets"][table] = int(rows[0].get("count") or 0) if rows else 0
    if mode in ("all", "aggregate"):
        rows = d1_query(cfg, _aggregate_count_sql(days))
        plan["aggregate_rows"] = int(rows[0].get("count") or 0) if rows else 0
        plan["aggregate_complete_days"] = int(days)
    return plan


def main() -> int:
    parser = argparse.ArgumentParser(description="D1 retention and daily aggregation")
    parser.add_argument(
        "--mode",
        choices=("all", "aggregate", "prune"),
        default="all",
        help="all=aggregate+prune; aggregate=aggregate only; prune=prune only",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform real writes/deletes; without it this is always a dry run.",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=AGGREGATE_COMPLETE_DAYS,
        metavar="N",
        help=(
            "how many complete UTC days the aggregation window covers "
            f"(default {AGGREGATE_COMPLETE_DAYS}); the current day is never included"
        ),
    )
    args = parser.parse_args()
    days = max(1, int(args.days))

    try:
        env = load_env(ENV_FILE)
        cfg = cloudflare_config(env)
        if not cfg["token"] or not cfg["account_id"] or not cfg["database_id"]:
            raise RuntimeError("Cloudflare / D1 config missing")
        if args.apply:
            if args.mode in ("all", "aggregate"):
                print(json.dumps(aggregate_daily(cfg, days), ensure_ascii=False, indent=2))
            if args.mode in ("all", "prune"):
                print(json.dumps(prune_buckets(cfg), ensure_ascii=False, indent=2))
        else:
            print(
                json.dumps(
                    {"dry_run": True, **dry_run(cfg, args.mode, days)},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            print("note: --apply not passed; no writes or deletes were performed.")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
