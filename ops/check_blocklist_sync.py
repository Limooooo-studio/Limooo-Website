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


"""Compare the D1 blocklist with the Cloudflare IP List, and show the last sync run.

Why this exists (2026-10-11): the daily sync Worker wrote
`ctx.waitUntil(sync(env))`, so a rejection was swallowed and the cron panel still
said "ran". Nothing recorded what the sync actually did, and the only way to notice
a divergence was to eyeball the Dashboard. This script is the missing black box
reader: it prints what SHOULD be in the list (D1 `blocked_ips` with `active = 1`),
what IS in the list (Cloudflare IP List API), the delta between them, and the last
recorded run per job (`worker_runs`, migration 018).

Exit codes:
    0  D1 and the IP List agree, and every reported job finished ok/skipped
    1  drift detected (to_add or to_remove is non-zero), or a job failed
    2  the check itself could not complete (credentials, D1, Cloudflare)

D1 cost: two reads, both tiny and both indexed --
    SELECT cidr FROM blocked_ips WHERE active = 1      (uses idx_blocked_ips_active)
    SELECT ... FROM worker_runs WHERE job = ? LIMIT 1   (uses idx_worker_runs_job_started)
No other table is touched. This is a read-only script: it never writes to the IP
List, and `--record` (opt-in) only appends to `worker_runs`.

Usage:
    python3 ops/check_blocklist_sync.py
    python3 ops/check_blocklist_sync.py --json
    python3 ops/check_blocklist_sync.py --record      # also log this check as a run
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

API = "https://api.cloudflare.com/client/v4"
LIST_NAME = "limooo_blocklist"
PAGE_SIZE = 500
MAX_PAGES = 20
# 运维脚本自己记账时用的 job 名，与两个 cron Worker 的 job 区分开。
CHECK_JOB = "blocklist_sync_check"
# 每张表最多打印几行；只影响输出，不影响判定。
SAMPLE_LIMIT = 10


def install_ca_bundle() -> None:
    """让本机 Python 用 certifi 的 CA 包（脚本要在任意 shell 里直接能跑）。

    macOS 的 framework Python 默认不吃 /opt/homebrew 的证书链，urllib 会直接
    `CERTIFICATE_VERIFY_FAILED`；这不是脚本的问题，但排障脚本因为 TLS 起不来就
    没用了，所以在这里兜底。显式设置 SSL_CERT_FILE 时以环境变量为准。
    """
    if os.environ.get("SSL_CERT_FILE"):
        return
    try:
        import certifi  # noqa: PLC0415 - 可选依赖，缺了就保持系统默认
    except ImportError:
        return
    os.environ["SSL_CERT_FILE"] = certifi.where()
    ssl._create_default_https_context = lambda: ssl.create_default_context(  # noqa: SLF001
        cafile=certifi.where()
    )


def normalize_list_item(value: str) -> str:
    """与 ops/sync-worker/src/index.ts 的 normalizeListItem 保持一致。

    Cloudflare 的 IP List 把 IPv4 /32 存成裸 IP、IPv6 /128 同理；两侧都用原始
    字符串比较时，同一条记录会被判成「既该加又该删」。
    """
    raw = (value or "").strip()
    slash = raw.rfind("/")
    if slash < 0:
        return raw
    addr, _, prefix = raw.partition("/")
    if prefix.isdigit():
        if int(prefix) == 32 and ":" not in addr:
            return addr
        if int(prefix) == 128 and ":" in addr:
            return addr
    return raw


def cf_get_json(token: str, url: str, attempts: int = 4) -> object:
    """带退避重试的 Cloudflare GET；绝不在错误信息里回显 token。"""
    last: Exception | None = None
    for _attempt in range(attempts):
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            last = RuntimeError(f"HTTP {exc.code} {url}: {detail}")
            if exc.code < 500:
                # 403/404 这类是明确的答案，重试没有意义。
                break
        except Exception as exc:  # noqa: BLE001 - 网络抖动统一重试
            last = exc
    raise RuntimeError(f"Cloudflare API request failed: {last}")


def find_list(cfg: dict[str, str]) -> dict:
    """按名字找 IP List；找不到直接报错（本脚本只读，不创建列表）。"""
    url = f"{API}/accounts/{cfg['account_id']}/rules/lists?per_page=100"
    payload = cf_get_json(cfg["token"], url)
    for item in payload.get("result") or []:
        if item.get("name") == LIST_NAME:
            return item
    raise RuntimeError(f"no IP List named {LIST_NAME} in account {cfg['account_id']}")


def list_items(cfg: dict[str, str], list_id: str) -> dict[str, str]:
    """返回 {归一化后的 ip: 列表项 id}，按 cursor 翻页（与 Worker 同一套规则）。"""
    items: dict[str, str] = {}
    cursor = ""
    for _ in range(MAX_PAGES):
        query = {"per_page": str(PAGE_SIZE)}
        if cursor:
            query["cursor"] = cursor
        url = (
            f"{API}/accounts/{cfg['account_id']}/rules/lists/{list_id}/items?"
            + urllib.parse.urlencode(query)
        )
        payload = cf_get_json(cfg["token"], url)
        rows = payload.get("result") or []
        for row in rows:
            ip = str(row.get("ip") or "")
            if ip:
                items[normalize_list_item(ip)] = str(row.get("id") or "")
        next_cursor = ((payload.get("result_info") or {}).get("cursor")) or ""
        if not next_cursor or not rows:
            return items
        if next_cursor == cursor:
            raise RuntimeError(f"list {list_id}: cursor did not advance ({next_cursor})")
        cursor = str(next_cursor)
    raise RuntimeError(f"list {list_id}: more than {MAX_PAGES} pages of items")


def query_last_runs(cfg: dict[str, str], jobs: list[str]) -> tuple[dict[str, dict | None], str | None]:
    """每个 job 最近一条运行记录（走 idx_worker_runs_job_started，各读 1 行）。

    返回 ({job: 最近一行}, 错误说明)。表缺失与查询失败分开描述 ——
    「读不到」不能当成「没有记录」。
    """
    found: dict[str, dict | None] = {}
    for job in jobs:
        # job 名来自本脚本内部常量/命令行，取值受控；仍然加引号转义以防万一。
        escaped = job.replace("'", "''")
        sql = (
            "SELECT job, started_at, finished_at, outcome, added, removed, error "
            f"FROM worker_runs WHERE job = '{escaped}' "
            "ORDER BY started_at DESC, id DESC LIMIT 1"
        )
        rows = d1_client.d1_query_retry(cfg, sql)
        if rows is None:
            return found, (
                "worker_runs query failed (network/API flake, or migration 018 was never "
                "applied); this does NOT mean no run was recorded"
            )
        found[job] = rows[0] if rows else None
    return found, None


def format_ts(value: object) -> str:
    if not isinstance(value, (int, float)):
        return "-"
    return dt.datetime.fromtimestamp(value, dt.UTC).strftime("%Y-%m-%d %H:%M:%SZ")


def format_run(job: str, row: dict | None) -> str:
    if row is None:
        return f"  {job:<22} {'-':<17} outcome=- added=- removed=-"
    started = format_ts(row.get("started_at"))
    outcome = str(row.get("outcome") or "-")
    added = row.get("added")
    removed = row.get("removed")
    line = (
        f"  {job:<22} {started:<17} outcome={outcome:<8} "
        f"added={' -' if added is None else added} removed={' -' if removed is None else removed}"
    )
    error = row.get("error")
    if error:
        line += f" error={str(error)[:160]}"
    return line


def compute_diff(desired: list[str], actual: dict[str, str]) -> tuple[list[str], list[str]]:
    """返回 (to_add, to_remove)，两侧都按归一化形式比较。

    to_add 报 D1 侧的**原始写法**（那才是 Worker 会推上去的值），to_remove 报
    列表侧的归一化值（Cloudflare 存的就是这个形式）。
    """
    desired_norm = {normalize_list_item(cidr) for cidr in desired}
    to_add = sorted(cidr for cidr in desired if normalize_list_item(cidr) not in actual)
    to_remove = sorted(ip for ip in actual if ip not in desired_norm)
    return to_add, to_remove


def record_check(cfg: dict[str, str], outcome: str, detail: str) -> str | None:
    """把这次人工检查也记进 worker_runs（opt-in）；返回错误说明。"""
    now = int(dt.datetime.now(dt.UTC).timestamp())
    escaped = detail.replace("'", "''")
    sql = (
        "INSERT INTO worker_runs (job, started_at, finished_at, outcome, error) "
        f"VALUES ('{CHECK_JOB}', {now}, {now}, '{outcome}', '{escaped}')"
    )
    try:
        d1_client.d1_query(cfg, sql)
    except Exception as exc:  # noqa: BLE001 - 记账失败不影响检查结论
        return str(exc)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare the D1 blocklist with the Cloudflare IP List"
    )
    parser.add_argument("--json", action="store_true", help="print one JSON object instead of text")
    parser.add_argument(
        "--record",
        action="store_true",
        help=f"also append this check to worker_runs as job={CHECK_JOB}",
    )
    parser.add_argument(
        "--job",
        action="append",
        default=None,
        help="only report this job's last run (repeatable); default: the two cron jobs",
    )
    args = parser.parse_args()

    install_ca_bundle()
    cfg = d1_client.cloudflare_config(d1_client.load_env(ROOT / "secrets" / "webauthn.env"))
    jobs = args.job or ["blocklist_sync", "d1_archive"]

    error: str | None = None
    desired: list[str] = []
    actual: dict[str, str] = {}
    runs: dict[str, dict | None] = {}
    run_error: str | None = None
    list_meta: dict = {}

    try:
        rows = d1_client.d1_query_retry(cfg, "SELECT cidr FROM blocked_ips WHERE active = 1")
        if rows is None:
            raise RuntimeError(
                "D1 read of blocked_ips failed (network/API flake, or credentials wrong)"
            )
        for row in rows:
            cidr = str(row.get("cidr") or "").strip()
            if cidr:
                desired.append(cidr)
        runs, run_error = query_last_runs(cfg, jobs)
        list_meta = find_list(cfg)
        actual = list_items(cfg, str(list_meta.get("id")))
    except Exception as exc:  # noqa: BLE001 - 运维脚本统一收口
        error = str(exc)

    if error:
        if args.json:
            print(json.dumps({"ok": False, "error": error}, ensure_ascii=False))
        else:
            print("desired=-  actual=-  to_add=-  to_remove=-  status=error")
            print(f"  error: {error}")
            print("  the check did not complete; this is NOT a statement about drift")
        return 2

    to_add, to_remove = compute_diff(desired, actual)
    failed_jobs = [
        job for job, row in runs.items() if row is not None and str(row.get("outcome")) == "failed"
    ]
    drift = bool(to_add) or bool(to_remove)
    status = "drift" if drift else ("failed_run" if failed_jobs else "ok")

    if args.json:
        if args.record:
            detail = f"status={status} to_add={len(to_add)} to_remove={len(to_remove)}"
            record_error = record_check(cfg, status, detail)
        else:
            record_error = None
        payload = {
            "ok": not drift and not failed_jobs,
            "status": status,
            "desired": len(desired),
            "actual": len(actual),
            "to_add": len(to_add),
            "to_remove": len(to_remove),
            "to_add_sample": to_add[:SAMPLE_LIMIT],
            "to_remove_sample": to_remove[:SAMPLE_LIMIT],
            "list": {
                "name": LIST_NAME,
                "id": list_meta.get("id"),
                "modified_on": list_meta.get("modified_on"),
            },
            "last_runs": {
                job: (
                    None
                    if row is None
                    else {
                        "started_at": row.get("started_at"),
                        "finished_at": row.get("finished_at"),
                        "outcome": row.get("outcome"),
                        "added": row.get("added"),
                        "removed": row.get("removed"),
                        "error": row.get("error"),
                    }
                )
                for job, row in runs.items()
            },
            "run_history_error": run_error,
            "record_error": record_error,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 1 if payload["ok"] is False else 0

    print("blocklist sync check")
    print(f"  {'list':<22}{LIST_NAME}")
    print(f"  {'list id':<22}{list_meta.get('id')}")
    print(f"  {'list modified_on':<22}{list_meta.get('modified_on')}")
    print(f"  {'d1 active':<22}{len(desired)}")
    print(f"  {'ip list items':<22}{len(actual)}")
    print(f"  desired={len(desired)} actual={len(actual)} to_add={len(to_add)} to_remove={len(to_remove)}")
    if to_add:
        print(f"  to add ({len(to_add)}):")
        for cidr in to_add[:SAMPLE_LIMIT]:
            print(f"    + {cidr}")
    if to_remove:
        print(f"  to remove ({len(to_remove)}):")
        for ip in to_remove[:SAMPLE_LIMIT]:
            print(f"    - {ip}")
    print("last runs (worker_runs)")
    for job in jobs:
        print(format_run(job, runs.get(job)))
    if run_error:
        print(f"  note: {run_error}")
    if failed_jobs:
        print(f"  failed jobs: {', '.join(failed_jobs)}")

    if args.record:
        detail = f"status={status} to_add={len(to_add)} to_remove={len(to_remove)}"
        record_error = record_check(cfg, status, detail)
        if record_error:
            print(f"  note: could not record this check: {record_error}")
        else:
            print(f"  recorded this check as {CHECK_JOB} outcome={status}")

    if drift:
        print(
            "result: DRIFT - the IP List does not match D1 active rows "
            "(run the sync, or wait for the 03:30 cron)"
        )
        return 1
    if failed_jobs:
        print(f"result: FAILED RUN - no drift, but these jobs last failed: {', '.join(failed_jobs)}")
        return 1
    print("result: OK - IP List matches D1 active rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
