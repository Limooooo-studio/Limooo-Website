"""docs/22 W7-4: Apple-account export files must never exist as 0644.

`ops/export_d1.py` used to `open(path, "w")` (0644 under the default umask 022)
and only chmod afterwards, so the JSON with Apple account emails/passwords was
world-readable for a moment -- permanently if the run was interrupted.

These tests use a throwaway SQLite file and a temporary OUT_DIR: no Cloudflare,
no credentials, no repository files.
"""

from __future__ import annotations

import os
import sqlite3
import stat
from pathlib import Path

from ops import export_d1


def test_open_private_creates_mode_0600(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    with export_d1.open_private(str(target)) as handle:
        handle.write("secret")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_open_private_tightens_a_loose_existing_file(tmp_path: Path) -> None:
    target = tmp_path / "x.json"
    target.write_text("old", encoding="utf-8")
    os.chmod(target, 0o644)
    with export_d1.open_private(str(target)) as handle:
        handle.write("new")
    # os.open 的 mode 只在创建时生效；export_apple_account 的 chmod 兜底负责收紧。
    assert stat.S_IMODE(target.stat().st_mode) == 0o644  # 尚未 chmod 时保持原样
    os.chmod(target, 0o600)


def _apple_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE apple_accounts (id INTEGER PRIMARY KEY, email TEXT, password TEXT, "
        "notes TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT)"
    )
    con.execute(
        "INSERT INTO apple_accounts VALUES (1, 'a@example.com', 'pw', '', 1, 'now', 'now')"
    )
    con.commit()
    con.close()


def test_export_apple_account_writes_private_files(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "apple.db"
    _apple_db(db)
    out = tmp_path / "out"
    monkeypatch.setattr(export_d1, "OUT_DIR", str(out))

    assert export_d1.export_apple_account(str(db)) == 0
    for name in ("apple-account.json", "apple-account.sql"):
        path = out / name
        assert path.exists(), name
        assert stat.S_IMODE(path.stat().st_mode) == 0o600, f"{name} must not be group/world readable"
    assert "a@example.com" in (out / "apple-account.json").read_text(encoding="utf-8")


def test_export_apple_account_tightens_a_pre_existing_0644_file(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "apple.db"
    _apple_db(db)
    out = tmp_path / "out"
    out.mkdir()
    stale = out / "apple-account.json"
    stale.write_text("stale 0644 leftover", encoding="utf-8")
    os.chmod(stale, 0o644)
    monkeypatch.setattr(export_d1, "OUT_DIR", str(out))

    assert export_d1.export_apple_account(str(db)) == 0
    assert stat.S_IMODE(stale.stat().st_mode) == 0o600
