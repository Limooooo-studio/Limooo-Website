#!/usr/bin/env python3
"""Export legacy VPS SQLite data into Cloudflare D1 import SQL/JSON.

Usage:
    python3 ops/export_d1.py apple-account [path/to/apple_account.db]
    python3 ops/export_d1.py blocklist
Output: ops/out/{apple-account,blocklist}.sql/json (git-ignored)

The old ops/export_apple_account.py / ops/export_blocklist.py are merged here.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from typing import TextIO

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(BASE_DIR, "ops", "out")
sys.path.insert(0, os.path.join(BASE_DIR, "src"))

from cidr import normalize_cidr, parse_cidr  # noqa: E402


def open_private(path: str) -> TextIO:
    """以 0600 创建文件再写。

    不能先 `open(path, "w")` 再 chmod：默认 umask 022 下文件会有一段时间是
    0644（内含 Apple 账号邮箱/密码/备注），中途 Ctrl-C 更会永久停在 0644。
    os.open 的 mode 只在**创建**时生效，所以 chmod 仍留作兜底（覆盖已存在的
    宽松文件）。
    """
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    return os.fdopen(fd, "w", encoding="utf-8")


def sql_str(value: object) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def export_apple_account(db_path: str) -> int:
    if not os.path.exists(db_path):
        print(f"FATAL: {db_path} does not exist", file=sys.stderr)
        return 1
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, email, password, notes, sort_order, created_at, updated_at "
        "FROM apple_accounts ORDER BY id"
    ).fetchall()
    conn.close()

    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, "apple-account.json")
    sql_path = os.path.join(OUT_DIR, "apple-account.sql")
    with open_private(json_path) as f:
        json.dump([dict(r) for r in rows], f, ensure_ascii=False, indent=2)
    with open_private(sql_path) as f:
        f.write(
            "INSERT OR IGNORE INTO apple_accounts "
            "(id, email, password, notes, sort_order, created_at, updated_at) VALUES\n"
        )
        values = [
            "("
            f"{r['id']}, {sql_str(r['email'])}, {sql_str(r['password'])}, {sql_str(r['notes'])}, "
            f"{int(r['sort_order'] or 0)}, {sql_str(r['created_at'])}, {sql_str(r['updated_at'])}"
            ")"
            for r in rows
        ]
        f.write(",\n".join(values) + ";\n")
    # 兜底：文件已存在且模式更宽松时（例如上一版留下的 0644）在这里收紧。
    os.chmod(json_path, 0o600)
    os.chmod(sql_path, 0o600)
    print(f"[export] {len(rows)} rows -> ops/out/apple-account.sql / apple-account.json", flush=True)
    return 0


def normalize_blocklist(line: str) -> str | None:
    """统一委托给 src/cidr.py，输出 canonical CIDR。"""
    return normalize_cidr(line)


def export_blocklist(src: str) -> int:
    if not os.path.exists(src):
        print(f"FATAL: {src} does not exist", file=sys.stderr)
        return 1
    seen: set[str] = set()
    with open(src, encoding="utf-8") as f:
        for raw in f:
            cidr = normalize_blocklist(raw)
            if cidr and cidr not in seen:
                seen.add(cidr)
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "blocklist.sql")
    with open(out, "w", encoding="utf-8") as f:
        f.write(
            "INSERT OR IGNORE INTO blocked_ips "
            "(cidr, network, prefix, reason, source, created_at, updated_at, updated_by, active) VALUES\n"
        )
        values = []
        for c in sorted(seen):
            parsed = parse_cidr(c)
            if not parsed:
                continue
            network, prefix = parsed
            values.append(
                f"({sql_str(c)}, {sql_str(network)}, {prefix}, 'blocklist.txt', "
                "'auto_block', datetime('now'), datetime('now'), 'export_d1', 1)"
            )
        f.write(",\n".join(values) + ";\n" if values else "-- no rows\n")
    print(f"[export] {len(seen)} entries -> {out}", flush=True)
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "apple-account":
        db_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA_DIR, "apple_account.db")
        return export_apple_account(db_path)
    if command == "blocklist":
        src = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA_DIR, "blocklist.txt")
        return export_blocklist(src)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
