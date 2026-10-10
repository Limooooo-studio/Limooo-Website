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


"""按 Cloudflare Ray ID 反查请求记录（边缘 + D1 双源），供管理员终端排障。

数据源：
    1. Cloudflare GraphQL Analytics API —— 边缘侧记录，能给出**真实客户端 IP**。
       注意：逐请求数据集 httpRequestsAdaptive（唯一含 rayName 的数据集）需要
       Logpush/Enterprise 级别的字段授权；当前 zone 无权访问 `rayname`，脚本在
       **权限错误**时会自动降级到聚合数据集 httpRequestsAdaptiveGroups
       （免费版可用），按「时间窗 + host + path + 状态码 + 客户端 IP」交叉定位同一
       请求；其它失败（网络/超时）不降级，聚合数据集里没有 Ray ID，给不出这个
       请求的记录，只会如实报错让你重试。
    2. D1 ray_log_v2 / ray_log / events —— 站点自己按 CF-Ray 记录的明细。
       只在 Pages 侧产生，且受保留策略清理，故仅作补充。

用法：
    python3 ops/check_ray_id.py a334352fe9806564-AMS
    RAYID=a334352fe9806564-AMS python3 ops/check_ray_id.py
    python3 ops/check_ray_id.py <rayid> --minutes 60   # 扩大边缘检索时间窗

退出码：0 有命中；1 无命中或查询失败；2 Ray ID 非法。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
ZONE_NAME = "limooo.cn"
DEFAULT_WINDOW_MINUTES = 30


def normalize_ray(raw: str) -> tuple[str, str]:
    """返回 (16 位小写 hex, colo 后缀大写或空)。"""
    value = (raw or "").strip()
    if not value:
        raise ValueError("invalid Ray ID")
    parts = value.split("-", 1)
    hexpart = parts[0].lower()
    colo = parts[1].upper() if len(parts) > 1 else ""
    hexpart = "".join(ch for ch in hexpart if ch in "0123456789abcdef")
    if not re.fullmatch(r"[0-9a-f]{16}", hexpart):
        raise ValueError("invalid Ray ID")
    return hexpart, colo


def cf_request(cfg: dict[str, str], url: str, body: object | None = None) -> dict:
    """带退避重试的 Cloudflare API 调用（本机到 CF 偶发连接重置）。"""
    headers = {"Authorization": f"Bearer {cfg['token']}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    last: Exception | None = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - 网络抖动统一重试
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Cloudflare API request failed: {last}")


def gql(cfg: dict[str, str], query: str) -> dict:
    payload = cf_request(cfg, GRAPHQL_URL, {"query": query})
    if payload.get("errors"):
        message = "; ".join(str(e.get("message")) for e in payload["errors"])
        raise RuntimeError(message)
    return payload.get("data") or {}


def zone_id(cfg: dict[str, str]) -> str | None:
    data = cf_request(cfg, f"https://api.cloudflare.com/client/v4/zones?name={ZONE_NAME}")
    for zone in data.get("result") or []:
        if zone.get("name") == ZONE_NAME:
            return zone.get("id")
    return None


def d1_lookup(cfg: dict[str, str], ray: str) -> tuple[list[str], str | None]:
    """D1 三表反查；返回 (格式化行, 错误信息)。"""
    like = f"{ray}%"
    queries = (
        (
            "ray_log_v2",
            "SELECT ray, ts, host, normalized_path AS path, method, status, "
            f"ip_hash, country FROM ray_log_v2 WHERE ray LIKE '{like}' ORDER BY ts DESC LIMIT 100",
        ),
        (
            "ray_log",
            "SELECT ray, ts, host, path, method, status, ip, country "
            f"FROM ray_log WHERE ray LIKE '{like}' ORDER BY ts DESC LIMIT 100",
        ),
        (
            "events",
            "SELECT event, ts, request_id AS ray, host, path, method, status, "
            f"outcome, ip_hash, country FROM events WHERE request_id LIKE '{like}' ORDER BY ts DESC LIMIT 100",
        ),
    )
    lines: list[str] = []
    errors: list[str] = []
    for source, sql in queries:
        rows = d1_query_retry(cfg, sql)
        if rows is None:
            # 网络/API 抖动与“确实没有记录”必须区分开，否则会把查不到
            # 误报成不存在。
            errors.append(source)
            continue
        for row in rows:
            lines.append(render_d1_row(source, row))
    error = (
        f"these tables failed to query (network/API flake; this does NOT mean there are no records): "
        f"{', '.join(errors)}"
        if errors
        else None
    )
    return lines, error


d1_query_retry = d1_client.d1_query_retry


def render_d1_row(source: str, row: dict[str, object]) -> str:
    ts = row.get("ts")
    stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if isinstance(ts, (int, float)) else ""
    host = row.get("host", "")
    method = row.get("method", "")
    path = row.get("path") or row.get("normalized_path") or ""
    status = row.get("status", "")
    identifier = row.get("ip_hash") or row.get("ip") or "-"
    country = row.get("country", "")
    return f"{stamp} {host} {method} {path} {status} ip={identifier} country={country} [{source}]"


def edge_lookup(
    cfg: dict[str, str],
    zone: str,
    ray: str,
    colo: str,
    minutes: int,
) -> tuple[list[str], str | None]:
    """边缘侧反查。

    逐请求数据集含 rayName 但当前 zone 无权访问；**只有**这种权限错误才退回
    聚合数据集（用时间窗交叉定位候选）。别的失败（网络、超时、GraphQL 报错）
    不能假装降级：聚合数据集里没有 Ray ID，给不出这个请求的记录，所以如实报错
    并让调用方重试。返回 (格式化行, 说明)。
    """
    since = (dt.datetime.now(dt.UTC) - dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    exact = f'''{{
      viewer {{ zones(filter: {{zoneTag: "{zone}"}}) {{
        httpRequestsAdaptive(limit: 10, filter: {{rayName: "{ray}", datetime_geq: "{since}"}}) {{
          rayName datetime clientRequestHTTPHost clientRequestHTTPMethodName clientRequestPath
          edgeResponseStatus clientIP clientCountryName clientASNDescription userAgent
        }}
      }} }}
    }}'''
    try:
        data = gql(cfg, exact)
        groups = (data.get("viewer", {}).get("zones") or [{}])[0].get("httpRequestsAdaptive") or []
        if groups:
            return [render_edge_row(r) for r in groups], None
        return [], None
    except RuntimeError as exc:
        detail = str(exc).lower()
        if "rayname" not in detail and "access to the field" not in detail:
            # 旧文案在这里说「已回退到聚合数据集」，但代码其实直接返回了 ——
            # 提示语与行为不符（docs/22 W7-12）。现在如实说明没有回退。
            return [], (
                f"edge per-request query failed ({exc}); this is not a permission error, "
                "so no aggregated fallback was attempted (the aggregated dataset has no Ray ID "
                "and cannot answer this lookup). Retry, or check the Ray ID again later."
            )

    # 聚合降级：没有 Ray ID，只能按时间窗 + colo 给出候选。
    agg = f'''{{
      viewer {{ zones(filter: {{zoneTag: "{zone}"}}) {{
        httpRequestsAdaptiveGroups(
          limit: 20,
          filter: {{datetime_geq: "{since}"}},
          orderBy: [datetime_DESC]
        ) {{
          count
          dimensions {{
            datetime clientIP clientRequestHTTPHost clientRequestPath clientRequestHTTPMethodName
            edgeResponseStatus clientCountryName coloCode
          }}
        }}
      }} }}
    }}'''
    data = gql(cfg, agg)
    groups = (data.get("viewer", {}).get("zones") or [{}])[0].get("httpRequestsAdaptiveGroups") or []
    # 注意：Ray ID 后缀 colo 只对**该请求**成立，而候选来自别的请求，
    # 因此不能按 colo 过滤（否则几乎必然空结果），colo 仅作展示参考。
    rows = [
        render_edge_row(item.get("dimensions") or {}, aggregated=True, count=item.get("count"))
        for item in groups
    ]
    note = (
        f"this account cannot read the per-request dataset httpRequestsAdaptive.rayName, "
        f"so the Ray ID cannot be pinpointed; below are edge request candidates from the last "
        f"{minutes} minutes (newest first, for cross-checking, NOT records of this Ray ID)."
    )
    return rows, note


def render_edge_row(row: dict[str, object], aggregated: bool = False, count: object = None) -> str:
    raw_ts = row.get("datetime")
    stamp = str(raw_ts).replace("T", " ").replace("Z", "")[:19] if raw_ts else ""
    host = row.get("clientRequestHTTPHost", "")
    method = row.get("clientRequestHTTPMethodName", "")
    path = row.get("clientRequestPath", "")
    status = row.get("edgeResponseStatus", "")
    ip = row.get("clientIP", "-")
    country = row.get("clientCountryName", "")
    asn = row.get("clientASNDescription", "")
    colo = row.get("coloCode", "")
    suffix = f" colo={colo}" if colo else ""
    count_part = f" count={count}" if aggregated and count else ""
    asn_part = f" asn={asn}" if asn else ""
    return f"{stamp} {host} {method} {path} {status} ip={ip} country={country}{asn_part}{suffix}{count_part} [edge]"


def main() -> int:
    parser = argparse.ArgumentParser(description="Look up request records by Cloudflare Ray ID")
    parser.add_argument("rayid", nargs="?", help="Cloudflare Ray ID, e.g. a334352fe9806564-AMS")
    parser.add_argument("--minutes", type=int, default=DEFAULT_WINDOW_MINUTES, help="edge search window in minutes")
    parser.add_argument(
        "--edge-candidates",
        action="store_true",
        help="also print degraded edge candidates even when D1 hits (by default only shown on a miss)",
    )
    args = parser.parse_args()

    raw = args.rayid or os.environ.get("RAYID") or ""
    try:
        ray, colo = normalize_ray(raw)
    except ValueError:
        print("invalid Ray ID", file=sys.stderr)
        return 2

    cfg = d1_client.cloudflare_config(d1_client.load_env(ROOT / "secrets" / "webauthn.env"))
    found = False

    # stderr 未缓冲会与 stdout 交错；每次切到 stderr 前先 flush。
    def warn(message: str) -> None:
        sys.stdout.flush()
        print(message, file=sys.stderr)
        sys.stderr.flush()

    # 1) 边缘
    print("Cloudflare edge", flush=True)
    degraded = False
    try:
        zone = zone_id(cfg)
        if not zone:
            warn(f"  could not resolve zone: {ZONE_NAME}")
        else:
            rows, note = edge_lookup(cfg, zone, ray, colo, args.minutes)
            if note:
                degraded = True
                edge_rows = rows
                print(f"  {note}")
                # 候选不是该 Ray ID 的记录，不计入 found；默认不刷屏，
                # 只有 D1 也没命中时才展开（或用 --edge-candidates 强制）。
                if args.edge_candidates:
                    for line in rows:
                        print("  " + line)
                    edge_rows = []
            else:
                edge_rows = rows
                for line in rows:
                    print("  " + line)
                found = found or bool(rows)
    except Exception as exc:  # noqa: BLE001 - 运维脚本统一收口
        warn(f"  edge query failed: {exc}")
        degraded, edge_rows = False, []

    # 2) D1（补充）
    print("D1 site logs", flush=True)
    d1_error = False
    try:
        rows, err = d1_lookup(cfg, ray)
        for line in rows:
            print("  " + line)
        found = found or bool(rows)
        if err:
            d1_error = True
            warn(f"  {err}")
    except Exception as exc:  # noqa: BLE001
        d1_error = True
        warn(f"  D1 query failed: {exc}")

    # 两个精确源都没命中、但存在降级候选时，展开候选供人工比对。
    if degraded and not found and edge_rows:
        print("edge candidates (degraded, not an exact match)", flush=True)
        for line in edge_rows:
            print("  " + line)

    if not found:
        if d1_error:
            # 查询失败 != 记录不存在，明确区分，避免误判为“没记录”。
            warn(f"\nquery incomplete: {ray} (D1 query failed; please retry)")
            return 1
        hint = " (no permission for an exact edge match; candidates listed for comparison)" if degraded else ""
        warn(f"\nno records found: {ray}" + (f"-{colo}" if colo else "") + hint)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
