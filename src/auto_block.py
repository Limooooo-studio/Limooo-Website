#!/usr/bin/env python3

# Limooo - Flask Web Application
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

"""
Blocklist sync script: reconcile the local blocklist snapshot with D1
`blocked_ips` (the single source of truth).

历史上这里还负责扫描 VPS 上的 Nginx access.log 来自动生成封禁网段；Nginx 随
`2026-09-17` 退租一并消失，扫描部分（`LOG_PATTERN` / `SCAN_PATTERNS` /
`_is_scan_path` / `collect_logs` / `analyze` / `run_scan`）已删除。现在的日志
来源只有 Cloudflare 边缘（`ray_log_v2` 等），封禁判定在 Pages / Worker 侧。

权威链路：D1 `blocked_ips` -> 每日 sync-worker -> Cloudflare IP List。
`blocklist.txt` 是本地导入种子/可审计快照；CF List 只有在显式维护命令
`auto_block.py cf` 才直接同步，默认运行路径不会写 Cloudflare。

Usage:
    python3 auto_block.py d1 [--dry-run]  # sync blocklist.txt to D1 (full diff)
    python3 auto_block.py cf              # maintenance: sync blocklist.txt to CF only
    python3 auto_block.py sync [--dry-run]  # alias of `d1` (不再直写 CF)
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request

from cidr import normalize_cidr, parse_cidr

# 仓库根目录（本文件位于 src/ 下，向上取一层）。
# 带 as 的常量各自独立成一条 import——ruff isort 就是这么切别名导入的
# （按配置里的原名排序），合并回一条会被 I001 判红。
from config import (
    BLOCKLIST_FILE as BLOCKLIST_TXT,
)
from config import (
    CF_BATCH_SIZE as BATCH,
)
from config import (
    CF_LIST_NAME as LIST_NAME,
)
from config import (
    CLOUDFLARE_API_BASE as API,
)
from config import (
    D1_DATABASE_ID,
    ENV_FILE,
)

# Match x.x.x.0/24
CIDR24_RE = re.compile(r'^(\d+\.\d+\.\d+)\.0/24$')


def read_blocklist_txt(path: str) -> tuple[list[str], set[str]]:
    """
    Read blocklist.txt, return:
    - static lines (comments + non-/24 manual entries)
    - existing /24 prefix set (stripped of .0/24 suffix)
    """
    static_lines: list[str] = []
    existing_prefixes: set[str] = set()

    try:
        with open(path) as f:
            for line in f:
                stripped = line.rstrip("\n")
                if stripped.startswith("#") or not stripped.strip():
                    static_lines.append(stripped)
                    continue
                m = CIDR24_RE.match(stripped)
                if m:
                    existing_prefixes.add(m.group(1))
                else:
                    static_lines.append(stripped)
    except FileNotFoundError:
        pass

    return static_lines, existing_prefixes


# ── Cloudflare IP List 同步（原 sync_blocklist_cf.py） ──
# 读 webauthn.env 里的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，
# 不存在则跳过。使用纯标准库(urllib)。
def load_env(path: str) -> dict:
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


def read_blocklist(path: str) -> list[str]:
    """读取 blocklist.txt 并返回规范化后的 CIDR 列表（无效行/注释忽略）。"""
    entries = []
    try:
        with open(path) as f:
            for line in f:
                cidr = normalize_cidr(line)
                if cidr and cidr not in entries:
                    entries.append(cidr)
    except FileNotFoundError:
        print("[!] blocklist.txt not found", file=sys.stderr)
    return entries


def _call(token: str, method: str, url: str, body=None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _wait_operation(token: str, account_id: str, operation_id: str | None):
    if not operation_id:
        return
    for _ in range(40):
        resp = _call(token, "GET",
                     f"{API}/accounts/{account_id}/rules/lists/bulk_operations/{operation_id}")
        status = resp.get("result", {}).get("status")
        if status in ("completed", "failed"):
            return
        time.sleep(2)


def _add_items(token: str, account_id: str, list_id: str, ips: list[str]):
    for i in range(0, len(ips), BATCH):
        chunk = [{"ip": ip} for ip in ips[i:i + BATCH]]
        resp = _call(token, "POST", f"{API}/accounts/{account_id}/rules/lists/{list_id}/items", chunk)
        _wait_operation(token, account_id, resp.get("result", {}).get("operation_id"))


def _remove_items(token: str, account_id: str, list_id: str, item_ids: list[str]):
    for i in range(0, len(item_ids), BATCH):
        # Cloudflare DELETE 只接受 {"items": [{"id": ...}]}，裸数组会返回 400 filters.api.invalid_json
        chunk = [{"id": x} for x in item_ids[i:i + BATCH]]
        resp = _call(token, "DELETE", f"{API}/accounts/{account_id}/rules/lists/{list_id}/items", {"items": chunk})
        _wait_operation(token, account_id, resp.get("result", {}).get("operation_id"))


def sync_cloudflare() -> int:
    """把 blocklist.txt 增量同步到 Cloudflare IP List，返回退出码"""
    env = load_env(ENV_FILE)
    token = env.get("CLOUDFLARE_API_TOKEN", "")
    account_id = env.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account_id:
        print("[cf] CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing, skipping", file=sys.stderr)
        return 0

    entries = read_blocklist(BLOCKLIST_TXT)
    if not entries:
        print("[!] blocklist empty, skipping CF sync", file=sys.stderr)
        return 0

    try:
        # Find existing list
        resp = _call(token, "GET", f"{API}/accounts/{account_id}/rules/lists?per_page=100")
        lst = next((item for item in resp.get("result", []) if item["name"] == LIST_NAME), None)

        if lst is None:
            resp = _call(token, "POST", f"{API}/accounts/{account_id}/rules/lists",
                         {"name": LIST_NAME, "kind": "ip", "description": "auto-blocked networks from nginx logs"})
            lst = resp["result"]
            _add_items(token, account_id, lst["id"], entries)
            print(f"[cf] created list {LIST_NAME} with {len(entries)} items", flush=True)
            return 0

        # Current items in CF (canonical cidr -> item id for deletion), follow cursor pagination
        cur = {}
        base = f"{API}/accounts/{account_id}/rules/lists/{lst['id']}/items"
        # url 在循环里会被赋成 None 来结束翻页（见下面那行 `if after else None`），
        # 所以类型是 str | None；循环条件 `while url` 已经把 None 挡在外面。
        url: str | None = base
        while url:
            resp = _call(token, "GET", url)
            for it in resp.get("result", []):
                canonical = _normalize_cidr(it.get("ip", ""))
                if canonical:
                    cur[canonical] = it["id"]
            cursors = (resp.get("result_info") or {}).get("cursors") or {}
            after = cursors.get("after")
            url = f"{base}?cursor={after}" if after else None

        target = set(entries)
        current = set(cur)
        to_add = sorted(target - current)
        to_remove = sorted(current - target)

        if not to_add and not to_remove:
            print(f"[cf] no change ({len(current)} items)", flush=True)
            return 0

        if to_add:
            _add_items(token, account_id, lst["id"], to_add)
        if to_remove:
            _remove_items(token, account_id, lst["id"], [cur[ip] for ip in to_remove])

        print(f"[cf] synced: +{len(to_add)} -{len(to_remove)} (total {len(target)})", flush=True)
    except urllib.error.HTTPError as e:
        print(f"[cf] HTTP error {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"[cf] error: {e}", file=sys.stderr)
        return 1

    return 0


def _normalize_cidr(line: str) -> str | None:
    """兼容旧测试名：统一委托给 src/cidr.py。"""
    return normalize_cidr(line)


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _d1_query(token: str, account_id: str, db_id: str, sql: str) -> list[dict]:
    """执行 D1 HTTP query 并提取首个结果集的 results。"""
    resp = _call(
        token,
        "POST",
        f"{API}/accounts/{account_id}/d1/database/{db_id}/query",
        {"sql": sql},
    )
    result = resp.get("result") or []
    if not result:
        return []
    first = result[0]
    if isinstance(first, dict):
        if first.get("success") is False:
            raise RuntimeError("D1 query failed")
        return first.get("results") or []
    return result


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def _upsert_blocklist(token: str, account_id: str, db_id: str, cidrs: list[str]) -> int:
    changes = 0
    for chunk in _chunks(cidrs, BATCH):
        values = []
        for cidr in chunk:
            parsed = parse_cidr(cidr)
            if parsed is None:
                continue
            network, prefix = parsed
            sql_value = (
                f"({_sql_str(cidr)}, {_sql_str(network)}, {prefix}, '', "
                f"'auto_block', datetime('now'), datetime('now'), 'auto_block')"
            )
            values.append(sql_value)
        if not values:
            continue
        sql = (
            f"INSERT INTO blocked_ips "
            f"(cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active) "
            f"VALUES {', '.join(values)} "
            "ON CONFLICT(cidr) DO UPDATE SET "
            "network=excluded.network, prefix=excluded.prefix, reason=excluded.reason, "
            "source=excluded.source, updated_at=excluded.updated_at, "
            "updated_by=excluded.updated_by, active=1"
        )
        resp = _call(
            token,
            "POST",
            f"{API}/accounts/{account_id}/d1/database/{db_id}/query",
            {"sql": sql},
        )
        meta = (resp.get("result") or [{}])[0].get("meta", {}) if resp.get("result") else {}
        changes += int(meta.get("changes", 0) or 0)
    return changes


def _delete_blocklist(token: str, account_id: str, db_id: str, cidrs: list[str]) -> int:
    changes = 0
    for chunk in _chunks(cidrs, BATCH):
        placeholders = ", ".join(_sql_str(cidr) for cidr in chunk)
        sql = (
            f"DELETE FROM blocked_ips "
            f"WHERE cidr IN ({placeholders}) "
            "AND source IN ('auto_block', 'blocklist.txt')"
        )
        resp = _call(
            token,
            "POST",
            f"{API}/accounts/{account_id}/d1/database/{db_id}/query",
            {"sql": sql},
        )
        meta = (resp.get("result") or [{}])[0].get("meta", {}) if resp.get("result") else {}
        changes += int(meta.get("changes", 0) or 0)
    return changes


def sync_d1(dry_run: bool = False) -> int:
    """把 blocklist.txt 作为导入快照，与 D1 blocked_ips 做全量 diff。

    - 新增/更新：INSERT ... ON CONFLICT（保留 created_at）
    - 删除：只删 source=auto_block/blocklist.txt 的活跃行，避免覆盖 admin 来源
    - 已由 API 解封的行（active=0）保留为审计墓碑，不会被重新加入
    - ``--dry-run`` 只输出 + / - 集合
    """
    env = load_env(ENV_FILE)
    token = env.get("CLOUDFLARE_API_TOKEN", "")
    account_id = env.get("CLOUDFLARE_ACCOUNT_ID", "")
    db_id = env.get("D1_DATABASE_ID", D1_DATABASE_ID)
    if not token or not account_id or not db_id:
        print("[d1] CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID missing, skipping", file=sys.stderr)
        return 0

    cidrs = read_blocklist(BLOCKLIST_TXT)
    if not cidrs:
        print("[d1] blocklist empty, skipping", file=sys.stderr)
        return 0

    try:
        rows = _d1_query(
            token,
            account_id,
            db_id,
            "SELECT cidr, network, prefix, source, active FROM blocked_ips",
        )
    except urllib.error.HTTPError as exc:
        print(f"[d1] HTTP error {exc.code}: {exc.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[d1] error: {exc}", file=sys.stderr)
        return 1

    desired = set(cidrs)
    known = {str(row.get("cidr", "")) for row in rows if row.get("cidr")}
    active_rows = {str(row["cidr"]): row for row in rows if row.get("cidr") and row.get("active", 1) == 1}
    to_add = sorted(cidr for cidr in desired if cidr not in known)
    to_delete = sorted(
        cidr
        for cidr, row in active_rows.items()
        if cidr not in desired and row.get("source") in (None, "", "auto_block", "blocklist.txt")
    )

    if dry_run:
        print(f"[d1] dry-run: +{len(to_add)} -{len(to_delete)}")
        for cidr in to_add:
            print(f"  + {cidr}")
        for cidr in to_delete:
            print(f"  - {cidr}")
        return 0

    try:
        added = _upsert_blocklist(token, account_id, db_id, to_add) if to_add else 0
        deleted = _delete_blocklist(token, account_id, db_id, to_delete) if to_delete else 0
    except urllib.error.HTTPError as exc:
        print(f"[d1] HTTP error {exc.code}: {exc.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[d1] error: {exc}", file=sys.stderr)
        return 1

    print(f"[d1] synced +{len(to_add)} -{len(to_delete)} (changes={added + deleted})", flush=True)
    return 0


def usage() -> None:
    print("Usage:", file=sys.stderr)
    print("  python3 auto_block.py d1 [--dry-run]    # sync blocklist.txt to D1 (full diff)", file=sys.stderr)
    print("  python3 auto_block.py cf                # maintenance: sync blocklist.txt to CF only", file=sys.stderr)
    print("  python3 auto_block.py sync [--dry-run]  # alias of d1 (never writes CF)", file=sys.stderr)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    dry_run = "--dry-run" in sys.argv[2:]
    if cmd in ("d1", "sync"):
        sys.exit(sync_d1(dry_run=dry_run))
    elif cmd == "cf":
        sys.exit(sync_cloudflare())
    else:
        # 默认分支原先跑 Nginx 日志扫描；数据源随 VPS 退租消失，现在只提示用法。
        usage()
        sys.exit(2)


if __name__ == "__main__":
    main()
