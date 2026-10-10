#!/usr/bin/env python3

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


"""Limooo 与 Cloudflare D1 API 的共享客户端。

只负责环境变量读取与 HTTP 查询；不回显 token/value。供 prune_d1.py 与
check_visitor_id.py / check_ray_id.py / check_ip_rays.py 等运维脚本复用。
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from config import CLOUDFLARE_API_BASE, D1_DATABASE_ID  # noqa: E402


def load_env(*paths: str | Path) -> dict[str, str]:
    """读取 env 文件；文件不存在时返回空字典，绝不回显值。"""
    result: dict[str, str] = {}
    for raw_path in paths:
        path = Path(raw_path)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip()
    return result


def env_value(env: dict[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
        value = env.get(name)
        if value:
            return value
    return default


def cloudflare_config(env: dict[str, str]) -> dict[str, str]:
    return {
        "token": env_value(env, "CLOUDFLARE_API_TOKEN"),
        "account_id": env_value(env, "CLOUDFLARE_ACCOUNT_ID"),
        "database_id": env_value(env, "D1_DATABASE_ID", default=D1_DATABASE_ID),
    }


def d1_query(cfg: dict[str, str], sql: str) -> list[dict[str, Any]]:
    """向 D1 API 发送单条 SQL；写操作同样通过 query 接口执行。"""
    token = cfg["token"]
    account_id = cfg["account_id"]
    database_id = cfg["database_id"]
    if not token or not account_id or not database_id:
        raise RuntimeError("Cloudflare / D1 config missing")
    url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/d1/database/{database_id}/query"
    body = json.dumps({"sql": sql}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail}") from exc
    if not data.get("success"):
        raise RuntimeError(f"D1 API returned a failure: {str(data)[:300]}")
    results = data.get("result") or []
    if not results:
        return []
    first = results[0] or {}
    if not first.get("success"):
        raise RuntimeError(f"D1 query failed: {str(first)[:300]}")
    return first.get("results") or []


def d1_query_retry(
    cfg: dict[str, str],
    sql: str,
    tries: int = 4,
    *,
    raise_on_failure: bool = False,
) -> list[dict[str, Any]] | None:
    """d1_query 的退避重试包装（本机到 Cloudflare 偶发连接重置）。

    原先在 check_ip_rays.py / check_ray_id.py / check_visitor_id.py 里各抄了一份，
    其中前两者返回 None、后者抛 RuntimeError；这里用 raise_on_failure 统一。

    失败语义很重要：返回 None 表示「查询失败」，与「确实没有记录」必须区分开，
    调用方不能把网络抖动说成没有数据。
    """
    last: Exception | None = None
    for attempt in range(tries):
        try:
            return d1_query(cfg, sql)
        except Exception as exc:  # noqa: BLE001 - 网络抖动统一收口
            last = exc
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    if raise_on_failure:
        raise RuntimeError(str(last))
    return None


SCAN_PROBE_CAP = 50_000


def bounded_row_count(
    cfg: dict[str, str],
    table: str,
    where: str = "",
    cap: int = SCAN_PROBE_CAP,
) -> tuple[int, bool] | None:
    """有界行数探测：返回 (行数, 是否触顶)；探测失败返回 None。

    排障脚本要如实提示「本次将扫多少行」（docs/22 W7-9），但 COUNT(*) 自己也要
    读表。这里把探测写成 `SELECT COUNT(*) FROM (SELECT 1 FROM t WHERE ... LIMIT cap)`，
    最多读 cap 行；触顶时只能说「至少 cap 行」，由调用方照实描述。
    """
    clause = f" WHERE {where}" if where else ""
    sql = f"SELECT COUNT(*) AS count FROM (SELECT 1 FROM {table}{clause} LIMIT {int(cap)})"
    rows = d1_query_retry(cfg, sql)
    if rows is None:
        return None
    count = int(rows[0].get("count") or 0) if rows else 0
    return count, count >= int(cap)


def scan_note(
    cfg: dict[str, str],
    table: str,
    where: str,
    reason: str,
    hint: str,
) -> str:
    """如实描述一次有代价查询的规模（docs/22 W7-9）。

    调用方传入的 where 决定了这次要读多少行：ray_log_v2 自迁移 017 起有
    (ip_hash, ts DESC) 索引，按 ip_hash 查已不是全表扫，但**有多少行仍取决于
    数据**（某个 IP 在 7 天窗口里可能一行都没有、也可能上千行）；visitor_rollups
    的 ip_enc 则依然没有索引，只能逐行解密。排障脚本本身不该成为下一次 D1 读取
    事故的原因，所以要在开查之前把「大概会读多少行」说清楚，并给出更便宜的入口。
    """
    probe = bounded_row_count(cfg, table, where)
    if probe is None:
        return (
            f"note: this run scans {table} ({reason}); the row count probe failed, "
            f"so the scan size is unknown. {hint}"
        )
    count, capped = probe
    sized = f"at least {count}" if capped else str(count)
    return f"note: this run scans {sized} rows of {table} ({reason}). {hint}"
