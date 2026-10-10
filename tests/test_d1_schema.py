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

"""D1 schema drift test (docs/22 W5-13).

Why this exists: `ops/migrations/*.sql` is applied to production D1 by hand
(`ops/migrate_d1.sh --remote`), while the code that reads and writes those tables
lives in `functions/**` and `ops/**`. Nothing connected the two, so a column that
exists only in the code (or only in a migration) was discovered by production,
not by CI.

What it does, all offline:

1. loads every `ops/migrations/*.sql` in filename order into an in-memory sqlite3;
2. asserts the tables `ops/migrate_d1.sh --check-schema` expects really exist;
3. asserts the tables each retention job DELETEs from exist, and that the
   timestamp column it filters on exists in that table;
4. walks the string literals of `functions/**`, `ops/**` and `src/**`, parses the
   `INSERT ... (columns)` / `UPDATE ... SET col = ...` targets and asserts every
   `(table, column)` pair exists in the schema built from the migrations.

The parser is deliberately textual, not a SQL engine: it only looks at literal
table names (plus same-file `const X = "name"` / `X = "name"` indirection such as
`AUTH_SESSION_TABLE`) and never at runtime-built names. A statement it cannot
parse is skipped for the column check but still checked for its table name.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "ops" / "migrations"

# Drift confirmed by hand before this test existed. New drift fails
# test_code_insert_update_references_exist; an entry is deleted as soon as the
# missing migration lands, so this mapping may only ever shrink.
#
# History: the first entry was
#   ("ops/status-worker/src/index.ts", "probe_state", "last_alert_at")
# -- the alert cooldown column only existed through a manual ALTER on production
# (visible in ops/backups/d1-limooo-*.sql) until ops/migrations/016_probe_state_last_alert_at.sql
# added it on 2026-10-11; the entry was removed in the same round.
KNOWN_SCHEMA_DRIFT: dict[tuple[str, str, str], str] = {}

# Where a `SET a = ..., b = ...` clause ends: either the tail of its own
# statement, or the beginning of the next one (the harvested literals are
# concatenated, so the next statement would otherwise look like an assignment).
STATEMENT_BOUNDARY = (
    "where", "returning", "insert", "update", "delete", "select", "create",
    "alter", "drop", "pragma", "begin", "commit",
)

# SQL keywords that may follow an identifier we harvested but are not columns.
SQL_KEYWORDS = {
    "select", "from", "where", "values", "set", "and", "or", "on", "as", "case",
    "when", "then", "else", "end", "conflict", "do", "update", "insert", "into",
    "delete", "returning", "excluded", "null", "not", "is", "in", "distinct",
    "order", "by", "limit", "group", "having", "union", "all", "join", "left",
    "inner", "outer", "primary", "key", "unique", "index", "table", "default",
    "unixepoch", "datetime", "strftime", "count", "sum", "max", "min", "coalesce",
    "ifnull", "cast", "integer", "text", "real", "blob", "like", "glob", "between",
    "exists", "with", "recursive", "replace", "ignore", "abort", "fail", "rollback",
    "escape", "collate", "asc", "desc", "offset", "current_timestamp", "true", "false",
}

# Directories whose string literals may contain production SQL.
SCAN_DIRS = ("functions", "ops", "src")
SCAN_SUFFIXES = (".ts", ".js", ".py")
SKIP_PARTS = ("__mocks__", "node_modules", "__pycache__")


def _migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


@pytest.fixture(scope="module")
def schema() -> dict[str, set[str]]:
    """Apply every migration in filename order; return {table: {column, ...}}."""
    con = sqlite3.connect(":memory:")
    try:
        for path in _migration_files():
            con.executescript(path.read_text(encoding="utf-8"))
        out: dict[str, set[str]] = {}
        for (table,) in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ):
            columns = {row[1] for row in con.execute(f'PRAGMA table_info("{table}")')}
            out[table] = columns
        return out
    finally:
        con.close()


# ── literal extraction ──────────────────────────────────────────────────────


def _string_literals(text: str) -> str:
    """Concatenate every string literal of a TS/JS/Python source file.

    SQL in this repo is frequently split over several adjacent literals
    (`"INSERT INTO t " "(a, b) " f"VALUES (...)"`), so the parser needs the pieces
    joined before it can see a whole statement. Comments are dropped; code between
    literals is replaced by a single space so token order survives.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "#" and not text.startswith("/*", i):
            end = text.find("\n", i)
            i = n if end < 0 else end + 1
            continue
        if text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end < 0 else end + 1
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        if ch in "\"'`":
            # Python triple-quoted strings.
            if text.startswith(ch * 3, i):
                end = text.find(ch * 3, i + 3)
                if end < 0:
                    out.append(text[i + 3 :])
                    break
                out.append(text[i + 3 : end])
                i = end + 3
                continue
            j = i + 1
            buf: list[str] = []
            while j < n:
                if text[j] == "\\":
                    buf.append(text[j : j + 2])
                    j += 2
                    continue
                if text[j] == ch:
                    break
                # 未转义换行终止普通字符串（Python 的 f-string 例外，这里按内容继续）
                if text[j] == "\n" and ch != "`" and not text.startswith("f\"", i - 1):
                    break
                buf.append(text[j])
                j += 1
            out.append("".join(buf))
            i = j + 1
            continue
        out.append(" ")
        i += 1
    return "".join(out)


def _template_constants(text: str) -> dict[str, str]:
    """Same-file `const NAME = "literal"` / `NAME = "literal"` table-name aliases."""
    found: dict[str, str] = {}
    for match in re.finditer(
        r"(?:const\s+|let\s+|var\s+)?([A-Z][A-Z0-9_]{2,})\s*[=:]\s*[a-zA-Z]?[\"']([a-z_][a-z0-9_]*)[\"']",
        text,
    ):
        found.setdefault(match.group(1), match.group(2))
    return found


def _resolve_table(raw: str, constants: dict[str, str]) -> str | None:
    """Resolve a harvested table reference; None when it is dynamic."""
    value = raw.strip()
    if value.startswith("${") and value.endswith("}"):
        value = constants.get(value[2:-1].strip(), "")
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", value or ""):
        return None
    return None if value.lower() in SQL_KEYWORDS else value


def _column_list_after(text: str, start: int) -> list[str] | None:
    """Read the `(a, b, c)` immediately after an INSERT target, if any."""
    j = start
    while j < len(text) and text[j] in " \t\r\n":
        j += 1
    if j >= len(text) or text[j] != "(":
        return None  # `VALUES (...)` / `SELECT ...`: no explicit column list
    depth = 0
    end = -1
    for k in range(j, len(text)):
        if text[k] == "(":
            depth += 1
        elif text[k] == ")":
            depth -= 1
            if depth == 0:
                end = k
                break
    if end < 0:
        return None
    inner = text[j + 1 : end]
    columns = [part.strip() for part in inner.split(",")]
    if not columns or not all(re.fullmatch(r"[a-z_][a-z0-9_]*", c or "") for c in columns):
        return None
    return [c for c in columns if c.lower() not in SQL_KEYWORDS]


def _split_top_level(clause: str) -> list[str]:
    """Split a SET clause on commas that are not inside parentheses."""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in clause:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return parts


def _assignment_columns(text: str, start: int, stop_keywords: tuple[str, ...]) -> list[str]:
    """Columns assigned by a `SET a = ..., b = ...` clause starting at `start`.

    The clause ends at the first statement-level keyword (`WHERE`, `RETURNING`,
    or the start of the next statement): the literals of a file are concatenated,
    so without that bound the next statement's column list would be harvested as
    assignments of this table.
    """
    end = len(text)
    for keyword in stop_keywords:
        found = re.search(rf"\b{keyword}\b", text[start:], re.IGNORECASE)
        if found:
            end = min(end, start + found.start())
    # SQL line comments may contain commas and `=`; drop them before splitting.
    clause = re.sub(r"--[^\n]*", " ", text[start:end])
    columns: list[str] = []
    for part in _split_top_level(clause):
        name = part.split("=")[0].strip()
        # `excluded.x = ...` / `t.x = ...` on the left is not valid SQL, but a
        # trailing qualifier is harmless to normalise away.
        name = name.rsplit(".", 1)[-1]
        if re.fullmatch(r"[a-z_][a-z0-9_]*", name or "") and name.lower() not in SQL_KEYWORDS:
            columns.append(name)
    return columns


def _sql_references() -> list[tuple[str, int, str, str]]:
    """Harvest `(file, line, table, column)` references from production sources."""
    references: list[tuple[str, int, str, str]] = []
    for directory in SCAN_DIRS:
        base = ROOT / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.suffix not in SCAN_SUFFIXES or not path.is_file():
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            if ".test." in path.name or path.name.startswith("test_"):
                continue
            if "migrations" in path.parts:
                continue
            raw = path.read_text(encoding="utf-8", errors="replace")
            constants = _template_constants(raw)
            sql = _string_literals(raw)
            rel = path.relative_to(ROOT).as_posix()
            last_insert: str | None = None
            # `INSERT [OR ...] INTO <table>` / `UPDATE <table> SET` / `DO UPDATE SET`
            for match in re.finditer(
                r"INSERT(?:\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO\s+([^\s(]+)"
                r"|(?<!DO\s)UPDATE\s+([^\s(]+)\s+SET\b"
                r"|(DO\s+UPDATE\s+SET\b)",
                sql,
                re.IGNORECASE,
            ):
                if match.group(3) is not None:
                    if last_insert is None:
                        continue
                    table = last_insert
                    columns = _assignment_columns(
                        sql, match.end(), STATEMENT_BOUNDARY
                    )
                elif match.group(1) is not None:
                    table = _resolve_table(match.group(1), constants)
                    last_insert = table
                    if table is None:
                        continue
                    columns = _column_list_after(sql, match.end()) or []
                else:
                    table = _resolve_table(match.group(2) or "", constants)
                    last_insert = None
                    if table is None:
                        continue
                    columns = _assignment_columns(
                        sql, match.end(), STATEMENT_BOUNDARY
                    )
                if table is None:
                    continue
                for column in columns:
                    references.append((rel, 0, table, column))
    return references


# ── tests ───────────────────────────────────────────────────────────────────


def test_migrations_load_in_order(schema: dict[str, set[str]]) -> None:
    """All 17 migrations must apply cleanly, in filename order, on an empty db."""
    files = _migration_files()
    assert len(files) >= 17, f"expected at least 17 migrations, found {len(files)}"
    assert list(schema), "no table was created by the migrations"
    for table in ("events", "blocked_ips", "auth_sessions", "visitor_rollups", "probes"):
        assert table in schema, f"migration set does not create {table}"


def test_migrate_script_expected_tables_exist(schema: dict[str, set[str]]) -> None:
    """`ops/migrate_d1.sh --check-schema` must only expect tables we can create."""
    script = (ROOT / "ops" / "migrate_d1.sh").read_text(encoding="utf-8")
    expected: set[str] = set()
    for match in re.finditer(r"expected\+?=\(([^)]*)\)", script):
        expected.update(re.findall(r"[a-z_][a-z0-9_]*", match.group(1)))
    assert expected, "could not read the expected table list out of ops/migrate_d1.sh"
    missing = sorted(table for table in expected if table not in schema)
    assert not missing, f"ops/migrate_d1.sh expects tables no migration creates: {missing}"


def _retention_targets() -> list[tuple[str, str, str]]:
    """(source, table, timestamp column) for both retention implementations."""
    targets: list[tuple[str, str, str]] = []

    ts_src = (ROOT / "ops" / "status-worker" / "src" / "retention.ts").read_text(
        encoding="utf-8"
    )
    overrides = dict(
        re.findall(r"^\s*([a-z_][a-z0-9_]*):\s*[\"']([a-z_][a-z0-9_]*)[\"'],", ts_src, re.M)
    )
    bucket_block = re.search(r"export const BUCKETS[^=]*=\s*\{(.*?)\n\};", ts_src, re.S)
    assert bucket_block, "could not read BUCKETS out of status-worker retention.ts"
    for table in re.findall(r"^\s*([a-z_][a-z0-9_]*):", bucket_block.group(1), re.M):
        targets.append(("ops/status-worker/src/retention.ts", table, overrides.get(table, "ts")))

    py_src = (ROOT / "ops" / "prune_d1.py").read_text(encoding="utf-8")
    py_overrides = dict(
        re.findall(r"^\s*[\"']([a-z_][a-z0-9_]*)[\"']:\s*[\"']([a-z_][a-z0-9_]*)[\"'],", py_src, re.M)
    )
    py_block = re.search(r"^BUCKETS[^=]*=\s*\{(.*?)^\}", py_src, re.S | re.M)
    assert py_block, "could not read BUCKETS out of ops/prune_d1.py"
    for table in re.findall(r"^\s*[\"']([a-z_][a-z0-9_]*)[\"']:", py_block.group(1), re.M):
        targets.append(("ops/prune_d1.py", table, py_overrides.get(table, "ts")))

    return targets


def test_retention_tables_and_timestamp_columns_exist(schema: dict[str, set[str]]) -> None:
    """Both retention jobs DELETE from real tables, filtered by real columns."""
    problems: list[str] = []
    for source, table, column in _retention_targets():
        if table not in schema:
            problems.append(f"{source}: table {table} does not exist in the migrations")
            continue
        if column not in schema[table]:
            problems.append(f"{source}: {table}.{column} does not exist in the migrations")
    assert not problems, "retention job targets drifted from the schema:\n  " + "\n  ".join(problems)
    assert len(_retention_targets()) >= 10, "retention table list looks truncated"


def test_code_insert_update_references_exist(schema: dict[str, set[str]]) -> None:
    """Every (table, column) written by production code must exist in the schema.

    Drift already confirmed by hand before this test existed is listed in
    KNOWN_SCHEMA_DRIFT with its evidence, so a NEW drift always fails here while
    the backlog stays visible instead of being erased by a weakened assertion.
    Fixing a listed item means deleting its entry -- the list may only shrink.
    """
    references = _sql_references()
    assert len(references) >= 60, (
        f"only {len(references)} column references harvested; the SQL scanner is broken"
    )
    problems: list[str] = []
    known: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    for source, _line, table, column in references:
        key = (source, table, column)
        if key in seen:
            continue
        seen.add(key)
        if table not in schema:
            message = f"{source}: INSERT/UPDATE into unknown table {table}"
        elif column not in schema[table]:
            message = f"{source}: {table}.{column} missing (schema has: {', '.join(sorted(schema[table]))})"
        else:
            continue
        if key in KNOWN_SCHEMA_DRIFT:
            known.append(f"{message} -- {KNOWN_SCHEMA_DRIFT[key]}")
        else:
            problems.append(message)
    assert not problems, (
        "code writes columns that ops/migrations/*.sql do not create:\n  "
        + "\n  ".join(sorted(problems))
        + (
            "\n  (already known, not failing: " + "; ".join(sorted(known)) + ")"
            if known
            else ""
        )
    )
