#!/usr/bin/env python3

"""按访客 ID（ip_hash）反查该访客的真实 IP 与访问概况，供管理员终端排障。

访客页每行显示的 `ID: xxxxxxxxxxxxxxxx` 就是 `visitor_rollups.ip_hash`
（HMAC-SHA256 前 16 位）。完整 IP 从 2026-09-26 起以 Fernet 密文存在
`visitor_rollups.ip_enc`，密钥是本机 secrets/webauthn.env 里的 VISITOR_IP_KEY
（与 Worker `functions/_lib/visitor-ip.ts` 用的是同一把，互相可解）。

数据源：D1 `visitor_rollups`（按 (ip_hash, last_ts) 索引精确取行，不扫表）。
`--requests` 会额外读 ray_log_v2，那张表没有 ip_hash 索引（只能扫），默认关闭。

注意：**2026-09-26 之前的行没有密文**，只有不可逆的哈希。脚本把
「查不到这个 ID」和「有记录但没密文」分开返回，不会把后者误报成不存在。

用法：
    python3 ops/check_visitor_id.py d51153cb767fc758
    VISITOR_ID=d51153cb767fc758 python3 ops/check_visitor_id.py
    python3 ops/check_visitor_id.py d51153cb767fc758 --requests 10

退出码：0 解出 IP；1 无记录 / 查询失败 / 缺密钥；2 ID 非法；3 有记录但无密文。
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

ID_RE = re.compile(r"[0-9a-f]{16}")
SECRETS_FILE = ROOT / "secrets" / "webauthn.env"


def normalize(raw: str) -> str:
    """接受 'd51153cb767fc758' / 'ID: d51153cb767fc758' / 大写，统一成小写 16 位。"""
    value = (raw or "").strip()
    value = re.sub(r"^(?:id|visitor)[\s:=]+", "", value, flags=re.IGNORECASE).strip()
    value = value.lower()
    if not ID_RE.fullmatch(value):
        raise ValueError("invalid visitor ID")
    return value


def fmt_ts(value: object) -> str:
    if not isinstance(value, (int, float)):
        return "-"
    return dt.datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M:%S")


def d1_query_retry(cfg: dict[str, str], sql: str, tries: int = 4) -> list[dict]:
    """持续失败时直接抛出（与其它 check_* 脚本的返回 None 语义不同）。"""
    return d1_client.d1_query_retry(cfg, sql, tries, raise_on_failure=True) or []


def decrypt_ip(token: str, key: str) -> str:
    """Fernet 解密；密钥/密文有问题时抛异常，由调用方给出可操作提示。"""
    try:
        from cryptography.fernet import Fernet
    except ImportError as exc:  # pragma: no cover - 取决于本机解释器
        raise RuntimeError(
            "this interpreter lacks cryptography, cannot decrypt ip_enc.\n"
            "  use an interpreter that has it: /tmp/limooo-venv/bin/python "
            f"{Path(__file__).name} <ID>\n"
            "  (recreate: python3 -m venv /tmp/limooo-venv && "
            "/tmp/limooo-venv/bin/pip install -r ops/requirements.txt)"
        ) from exc
    return Fernet(key.encode("ascii")).decrypt(token.encode("ascii")).decode("utf-8")


def summarize(rows: list[dict]) -> str:
    return " ".join(f"{r['status']}×{r['n']}" for r in rows) or "-"


def main() -> int:
    parser = argparse.ArgumentParser(description="Look up the real IP and visit summary by visitor ID")
    parser.add_argument("visitor_id", nargs="?", help="the 16-char ID shown on the visitor page (ip_hash)")
    parser.add_argument(
        "--requests",
        type=int,
        default=0,
        metavar="N",
        help="also list the most recent N request details (reads ray_log_v2; that table has no ip_hash index, so it scans)",
    )
    args = parser.parse_args()

    raw = args.visitor_id or os.environ.get("VISITOR_ID") or ""
    try:
        visitor = normalize(raw)
    except ValueError:
        print("invalid visitor ID (expected 16 hex chars, e.g. d51153cb767fc758)", file=sys.stderr)
        return 2

    def warn(message: str) -> None:
        sys.stdout.flush()
        print(message, file=sys.stderr)
        sys.stderr.flush()

    env = d1_client.load_env(SECRETS_FILE)
    key = (os.environ.get("VISITOR_IP_KEY") or env.get("VISITOR_IP_KEY") or "").strip()
    cfg = d1_client.cloudflare_config(env)

    print(f"visitor {visitor}", flush=True)
    try:
        totals = d1_query_retry(
            cfg,
            "SELECT COUNT(*) AS rows_n, COALESCE(SUM(requests), 0) AS total_requests, "
            "MIN(last_ts) AS first_ts, MAX(last_ts) AS last_ts, "
            "GROUP_CONCAT(DISTINCT NULLIF(country, '')) AS countries "
            f"FROM visitor_rollups WHERE ip_hash = '{visitor}'",
        )
    except Exception as exc:  # noqa: BLE001
        warn(f"  D1 query failed: {exc}")
        warn(f"\nquery incomplete: {visitor} (this does NOT mean there is no record; please retry)")
        return 1

    row = totals[0] if totals else {}
    if not row or not row.get("rows_n"):
        warn(f"\nno records found: {visitor} (this ID is outside the visitor_rollups retention window)")
        return 1

    statuses = d1_query_retry(
        cfg,
        "SELECT status, SUM(requests) AS n FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' GROUP BY status ORDER BY n DESC",
    )
    pages = d1_query_retry(
        cfg,
        "SELECT page_slug, SUM(requests) AS n FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' GROUP BY page_slug ORDER BY n DESC LIMIT 8",
    )

    print(f"  first      {fmt_ts(row.get('first_ts'))}")
    print(f"  last       {fmt_ts(row.get('last_ts'))}")
    print(f"  requests   {row.get('total_requests')} visits / {row.get('rows_n')} rollup rows")
    print(f"  country    {row.get('countries') or '-'}")
    print(f"  status     {summarize(statuses)}")
    print("  pages      " + (" ".join(f"{r['page_slug']}×{r['n']}" for r in pages) or "-"))

    # 密文只取最近一条：同一个 IP 的小时行很多，但密文内容一致。
    tokens = d1_query_retry(
        cfg,
        "SELECT ip_enc, last_ts FROM visitor_rollups "
        f"WHERE ip_hash = '{visitor}' AND ip_enc != '' ORDER BY last_ts DESC LIMIT 1",
    )
    token = (tokens[0].get("ip_enc") if tokens else "") or ""

    if not token:
        print("  IP         unavailable")
        warn(
            "\nthis visitor only has records from before 2026-09-26: only an HMAC hash was stored then, "
            "which is irreversible.\n"
            "if the same IP visits once more, this row will automatically carry a decryptable IP."
        )
        return 3

    if not key:
        warn(f"  ciphertext found, but {SECRETS_FILE} has no VISITOR_IP_KEY, cannot decrypt.")
        return 1
    try:
        ip = decrypt_ip(token, key)
    except Exception as exc:  # noqa: BLE001
        warn(f"  decryption failed: {exc}")
        return 1

    print(f"  IP         {ip}")
    print(f"  ciphertext {fmt_ts(tokens[0].get('last_ts'))} (Fernet / VISITOR_IP_KEY, decrypted locally)")

    if args.requests > 0:
        print(f"recent requests (ray_log_v2, up to {args.requests})", flush=True)
        # docs/22 W7-9：ray_log_v2 没有 (ip_hash, ts DESC) 索引，这条查询是全表扫；
        # 开扫之前先报出代价，别让排障脚本自己撞上 D1 读取预算。
        warn(
            "  "
            + d1_client.scan_note(
                cfg,
                "ray_log_v2",
                f"ip_hash = '{visitor}'",
                "no (ip_hash, ts DESC) index; the 7-day detail table is scanned",
                "The main lookup above uses the (ip_hash, last_ts) index instead; drop --requests to avoid this scan.",
            )
        )
        try:
            hits = d1_query_retry(
                cfg,
                "SELECT ts, host, normalized_path, method, status, country, ua_family "
                f"FROM ray_log_v2 WHERE ip_hash = '{visitor}' "
                f"ORDER BY ts DESC LIMIT {int(args.requests)}",
            )
        except Exception as exc:  # noqa: BLE001
            warn(f"  ray_log_v2 query failed: {exc}")
            hits = []
        if not hits:
            print("  (no detail records within the retention window)")
        for hit in hits:
            print(
                f"  {fmt_ts(hit.get('ts'))} {hit.get('host')} {hit.get('method')} "
                f"{hit.get('normalized_path')} {hit.get('status')} "
                f"country={hit.get('country')} ua={hit.get('ua_family')} [ray_log_v2]"
            )
    else:
        print("  (pass --requests 10 to list this visitor's recent request details)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
