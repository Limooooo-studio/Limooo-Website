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


"""按客户端 IP 反查它最近的 Ray ID（D1 双表），供管理员终端排障。

为什么不是「直接按 IP 查表」：
    D1 里 IP 是脱敏存储的，两张表各有一半信息 ——
      1. `ray_log_v2`（保留 7 天）有 ray/时间/host/路径/状态，但只有
         `ip_hash`（OBSERVABILITY_HMAC_KEY 的 HMAC-SHA256 前 16 位）。
         该密钥是 Pages 的 write-only Secret，本机拿不到，无法现算。
      2. `visitor_rollups.ip_enc` 是 Fernet 密文（`VISITOR_IP_KEY`，本机有），
         能还原**明文 IP**，并带同一行的 `ip_hash`。
    所以链路是：明文 IP → 在所有 ip_enc 里找出匹配行 → 拿到 ip_hash
    → 用 ip_hash 去 ray_log_v2 取最近 N 条 ray。

    `ray_log`（旧表）存的是明文 IP，可直接精确匹配，但 2026-09-25 起已停写，
    故仅作历史兜底。

用法：
    python3 ops/check_ip_rays.py 176.122.161.108          # 默认最近 5 条
    python3 ops/check_ip_rays.py 176.122.161.108 --limit 10
    python3 ops/check_ip_rays.py --hash d51153cb767fc758   # 已知 ip_hash 时跳过解密
    python3 ops/check_ip_rays.py 8.8.8.8 --json

退出码：0 有命中；1 无命中或查询失败；2 参数非法。
"""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("LIMOOO_ROOT") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))

from ops import d1_client  # noqa: E402

DEFAULT_LIMIT = 5

# ip_enc 需要 cryptography；缺失时只降级掉「IP → hash」这半步，不影响 --hash。
try:
    from cryptography.fernet import Fernet, InvalidToken  # noqa: E402
except ImportError:  # pragma: no cover - 取决于解释器
    Fernet = None  # type: ignore[assignment]

    class InvalidToken(Exception):  # type: ignore[no-redef]
        """占位：cryptography 缺失时也不会被用到。"""


def normalize_ip(raw: str) -> str:
    """校验并归一化 IP（IPv4/IPv6）；非法时抛 ValueError。"""
    value = (raw or "").strip()
    if not value:
        raise ValueError("empty IP")
    # 去掉 curl/日志里常见的方括号与端口： [::1]:443 / 1.2.3.4:80
    if value.startswith("["):
        value = value[1:].split("]", 1)[0]
    else:
        try:
            return str(ipaddress.ip_address(value))
        except ValueError:
            pass
        if value.count(":") == 1 and "." in value:
            value = value.split(":", 1)[0]
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as exc:
        raise ValueError(f"invalid IP: {raw}") from exc


def looks_like_hash(raw: str) -> bool:
    value = (raw or "").strip().lower()
    return len(value) == 16 and all(ch in "0123456789abcdef" for ch in value)


d1_query_retry = d1_client.d1_query_retry


def warn(message: str) -> None:
    """先 flush stdout 再写 stderr，避免两个流交错。"""
    sys.stdout.flush()
    print(message, file=sys.stderr)
    sys.stderr.flush()


scan_cost_note = d1_client.scan_note


def visitor_key(env: dict[str, str]) -> str:
    return d1_client.env_value(env, "VISITOR_IP_KEY")


def resolve_hashes(cfg: dict[str, str], env: dict[str, str], ip: str) -> tuple[list[str], str | None]:
    """明文 IP → ip_hash 集合：解密所有 ip_enc 行并比对。

    返回 (hash 列表, 警告)。警告非空表示链路降级或不完整，调用方需如实提示，
    不能把「解不出来」说成「没有记录」。
    """
    key = visitor_key(env)
    if not key:
        return [], "VISITOR_IP_KEY is missing; cannot decrypt ip_enc (use --hash, or the legacy ray_log table)"
    if Fernet is None:
        return [], "this python has no cryptography module; cannot decrypt ip_enc (use an interpreter that has it)"

    rows = d1_query_retry(cfg, "SELECT ip_hash, ip_enc, last_ts FROM visitor_rollups WHERE ip_enc IS NOT NULL AND ip_enc != ''")
    if rows is None:
        return [], "visitor_rollups query failed (network/API flake; this does not mean there is no record)"

    try:
        fernet = Fernet(key.encode())
    except Exception:  # noqa: BLE001
        return [], "VISITOR_IP_KEY is not a valid Fernet key"

    target = ipaddress.ip_address(ip)
    hashes: list[str] = []
    for row in rows:
        token = row.get("ip_enc") or ""
        if not token:
            continue
        try:
            candidate = fernet.decrypt(str(token).encode()).decode()
        except (InvalidToken, ValueError, TypeError):
            continue  # 换过密钥的历史行解不开，跳过
        try:
            if ipaddress.ip_address(candidate) != target:
                continue
        except ValueError:
            continue
        row_hash = str(row.get("ip_hash") or "").strip()
        if row_hash and row_hash not in hashes:
            hashes.append(row_hash)

    if not hashes:
        # ip_enc 只覆盖启用该功能之后的行，空结果不等于「该 IP 没来过」。
        return [], "this IP is not present in ip_enc (that column only covers records written after encryption was enabled; it may be an older visit)"
    return hashes, None


def rays_by_hash(cfg: dict[str, str], hashes: list[str], limit: int) -> tuple[list[dict], str | None]:
    """按 ip_hash 从 ray_log_v2 取最近 limit 条。"""
    if not hashes:
        return [], None
    quoted = ", ".join("'" + h.replace("'", "''") + "'" for h in hashes)
    sql = (
        "SELECT ray, ts, host, normalized_path AS path, method, status, country, ip_hash, duration_ms "
        f"FROM ray_log_v2 WHERE ip_hash IN ({quoted}) ORDER BY ts DESC LIMIT {int(limit)}"
    )
    rows = d1_query_retry(cfg, sql)
    if rows is None:
        return [], "ray_log_v2 query failed (network/API flake; this does not mean there is no record)"
    return rows, None


def rays_legacy(cfg: dict[str, str], ip: str, limit: int) -> tuple[list[dict], str | None]:
    """旧表 ray_log 明文 IP 精确匹配（2026-09-25 已停写，仅历史兜底）。"""
    sql = (
        "SELECT ray, ts, host, path, method, status, country, ip "
        f"FROM ray_log WHERE ip = '{ip.replace(chr(39), chr(39) * 2)}' ORDER BY ts DESC LIMIT {int(limit)}"
    )
    rows = d1_query_retry(cfg, sql)
    if rows is None:
        return [], "ray_log query failed (network/API flake; this does not mean there is no record)"
    return rows, None


def render_v2(row: dict) -> str:
    ts = row.get("ts")
    stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if isinstance(ts, (int, float)) else ""
    host = str(row.get("host", ""))
    method = str(row.get("method", ""))
    path = str(row.get("path", ""))
    status = str(row.get("status", ""))
    country = str(row.get("country", ""))
    duration = row.get("duration_ms")
    ms = f"{int(duration)}ms" if isinstance(duration, (int, float)) and duration else ""
    # 定宽对齐：时间/ray/状态/方法/国家/耗时不抖动；host+path 放最后（长度不可控）。
    return f"{stamp} {row.get('ray',''):<22} {status:>3} {method:<4} {country:<2} {ms:>7}  {host}{path}"


def render_legacy(row: dict) -> str:
    ts = row.get("ts")
    stamp = dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if isinstance(ts, (int, float)) else ""
    host = str(row.get("host", ""))
    method = str(row.get("method", ""))
    path = str(row.get("path", ""))
    status = str(row.get("status", ""))
    country = str(row.get("country", ""))
    return f"{stamp} {row.get('ray',''):<22} {status:>3} {method:<4} {country:<2} {'-':>7}  {host}{path} [legacy]"


def main() -> int:
    parser = argparse.ArgumentParser(description="Look up the most recent Ray IDs for a client IP")
    parser.add_argument("target", nargs="?", help="client IP, e.g. 176.122.161.108 / 240e:404::1")
    parser.add_argument("--hash", dest="hash_value", help="known ip_hash (16 hex chars); skips IP decryption")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"number of rows to return (default {DEFAULT_LIMIT})")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = parser.parse_args()

    limit = max(1, args.limit)
    env = d1_client.load_env(ROOT / "secrets" / "webauthn.env")
    cfg = d1_client.cloudflare_config(env)

    warnings: list[str] = []
    hashes: list[str] = []
    ip = ""

    if args.hash_value:
        raw_hash = args.hash_value.strip().lower()
        if not looks_like_hash(raw_hash):
            print("invalid ip_hash (expect 16 hex chars)", file=sys.stderr)
            return 2
        hashes = [raw_hash]
    else:
        try:
            ip = normalize_ip(args.target or "")
        except ValueError:
            print("invalid IP", file=sys.stderr)
            return 2
        # 先报代价再开扫：要解密全部 ip_enc 才能把明文 IP 映射到 ip_hash。
        warn(
            scan_cost_note(
                cfg,
                "visitor_rollups",
                "ip_enc IS NOT NULL AND ip_enc != ''",
                "no index on ip_enc; every ciphertext row is decrypted locally",
                "Pass --hash <ip_hash> to skip this step when the hash is already known.",
            )
        )
        hashes, warn_msg = resolve_hashes(cfg, env, ip)
        if warn_msg:
            warnings.append(warn_msg)

    warn(
        scan_cost_note(
            cfg,
            "ray_log_v2",
            "",
            "no (ip_hash, ts DESC) index; the 7-day detail table is scanned",
            "Pass --hash <ip_hash> to avoid the ip_enc scan, but ray_log_v2 stays a scan.",
        )
    )
    rows, warn_msg = rays_by_hash(cfg, hashes, limit)
    if warn_msg:
        warnings.append(warn_msg)

    legacy: list[dict] = []
    if ip and len(rows) < limit:
        # v2 命中不足时，用旧表补齐（旧表有明文 IP）。
        extra, warn2 = rays_legacy(cfg, ip, limit - len(rows))
        if warn2:
            warnings.append(warn2)
        legacy = [r for r in extra if r.get("ray") not in {x.get("ray") for x in rows}]

    if args.json:
        print(json.dumps(
            {
                "ip": ip or None,
                "ip_hashes": hashes,
                "rays": rows,
                "legacy_rays": legacy,
                "warnings": warnings,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        ))
        return 0 if (rows or legacy) else 1

    label = ip or f"hash:{hashes[0]}"
    print(f"{label} latest {limit} Ray ID(s)", flush=True)
    if hashes:
        print(f"  ip_hash {', '.join(hashes)}")
    for row in rows:
        print("  " + render_v2(row))
    for row in legacy:
        print("  " + render_legacy(row))

    for note in dict.fromkeys(warnings):
        print(f"  note: {note}", file=sys.stderr)

    if not rows and not legacy:
        print(f"\nno records found: {label}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
