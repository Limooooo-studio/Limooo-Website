#!/usr/bin/env bash

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

# Limooo D1 迁移入口。
#
# 用法：
#   bash ops/migrate_d1.sh --dry-run                 # 只打印计划；完全离线
#   bash ops/migrate_d1.sh --remote                  # 对生产 D1 执行尚未记账的迁移
#   bash ops/migrate_d1.sh --check-schema --remote   # 只读校验表是否齐全
#
# 「已应用」以 D1 的 schema_version 为唯一事实源。仓库内 .d1-migrations/applied
# 只是离线计划的缓存：旧版本在缺 --remote 时会打到本地 .wrangler sqlite 却照样
# 记账，那份缓存不可信，故不再参与跳过判断。
#
# 迁移前请先备份 D1（见 docs/parallel-actions.md）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/ops/migrations"
STATE_FILE="${D1_STATE_FILE:-$ROOT/.d1-migrations/applied}"
LEGACY_STATE_FILE="/tmp/limooo-d1-schema-state"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-limooo}"
# 预先保存的 wrangler --json 载荷：设置后 --check-schema 完全离线（调试与测试用）
SCHEMA_JSON_FILE="${LIMOOO_D1_SCHEMA_JSON:-}"
WRANGLER_BIN="${WRANGLER_BIN:-}"
if [ -n "$WRANGLER_BIN" ]; then
    WRANGLER_CMD=("$WRANGLER_BIN")
else
    WRANGLER_CMD=(npx --no-install wrangler)
fi

DRY_RUN=0
REMOTE=0
CHECK_SCHEMA=0

usage() {
    cat <<'EOF'
Usage: bash ops/migrate_d1.sh [--dry-run] [--remote] [--check-schema]

  --dry-run       print the migration plan only; never contacts D1 (works offline).
  --remote        run against the remote (production) D1 database. Required for
                  --check-schema and for applying migrations: the old local mode
                  executed against the local .wrangler sqlite while still recording
                  the files as applied, so production silently never got the change.
  --check-schema  check that remote D1 has every expected table; no migration.

Applied state: the D1 table schema_version is the single source of truth. Its key is
version * 1000 + sequence (004_schema_version.sql -> 4003), so files sharing a number
stay distinguishable. Rows written by older versions of this script carry the plain
version number and still count as applied for every file with that number. New
migrations must use the next free number (the highest number in ops/migrations/ plus
one): duplicate numbers are reported, and a legacy row can never tell them apart.

Offline schema check: set LIMOOO_D1_SCHEMA_JSON=<file> to the payload of
  wrangler d1 execute limooo --command "SELECT name FROM sqlite_master WHERE type='table'" --json
and --check-schema validates that payload without contacting D1 (debug and tests).
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --remote) REMOTE=1 ;;
        --check-schema) CHECK_SCHEMA=1 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "FATAL: unknown argument $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "FATAL: migrations directory not found: $MIGRATIONS_DIR" >&2
    exit 1
fi

# 模式校验（W3-4 / W3-5）：
#   * apply 缺 --remote 会打到本地 sqlite 却记成已应用 → 直接拒绝；
#   * --check-schema 缺 --remote 只读本地库、且在 bash < 4.4 上会崩在空数组展开
#     → 同样要求显式声明目标；要用离线校验请给 LIMOOO_D1_SCHEMA_JSON。
#   * --dry-run 完全离线，不受此限。
if [ "$DRY_RUN" = 0 ] && [ "$REMOTE" = 0 ]; then
    if [ "$CHECK_SCHEMA" = 1 ] && [ -n "$SCHEMA_JSON_FILE" ]; then
        : # 离线校验保存好的 sqlite_master 载荷，不连 D1
    else
        echo "FATAL: --remote is required for --check-schema and for applying migrations" >&2
        echo "       use --dry-run for an offline plan, or set LIMOOO_D1_SCHEMA_JSON=<file>" >&2
        echo "       to validate a saved sqlite_master payload without contacting D1" >&2
        exit 2
    fi
fi

# 兼容旧版临时状态文件：迁移到仓库内持久化位置。它只是离线计划的缓存，
# 不参与「已应用」判断（那份以 D1 schema_version 为准）。
if [ -f "$LEGACY_STATE_FILE" ] && [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    cp "$LEGACY_STATE_FILE" "$STATE_FILE"
    echo "[d1] migrated legacy plan cache to $STATE_FILE"
fi

MIGRATION_NAMES=()
while IFS= read -r file; do
    name="$(basename "$file")"
    if ! [[ "$name" =~ ^[0-9]{3}_[A-Za-z0-9_-]+\.sql$ ]]; then
        echo "FATAL: migration filename does not match 001_name.sql convention: $name" >&2
        exit 1
    fi
    MIGRATION_NAMES+=("$name")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

# 重号检测（W3-8）：004 被三个文件共用，旧的纯版本号（version=4）无法区分它们。
# 只告警不阻断（历史文件名不能改）；新迁移必须用下一个空闲编号。
duplicate_seen=0
max_prefix=0
warned_prefixes=" "
for name in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
    prefix="${name%%_*}"
    if [ "$((10#$prefix))" -gt "$max_prefix" ]; then
        max_prefix="$((10#$prefix))"
    fi
    case "$warned_prefixes" in
        *" $prefix "*) continue ;;
    esac
    group=""
    count=0
    for other in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
        if [ "${other%%_*}" = "$prefix" ]; then
            count=$((count + 1))
            group="$group $other"
        fi
    done
    if [ "$count" -gt 1 ]; then
        warned_prefixes="$warned_prefixes$prefix "
        duplicate_seen=1
        echo "[d1] warning: migration number $prefix is used by $count files:$group"
    fi
done
next_free="$(printf '%03d' "$((max_prefix + 1))")"
if [ "$duplicate_seen" = 1 ]; then
    echo "[d1] warning: a legacy version row cannot tell duplicate numbers apart; new migrations must use the next free number ($next_free)"
fi

# 迁移键：version * 1000 + 同号文件中的次序（1 起）。同号文件因此互不覆盖。
migration_key() {
    local name="$1" prefix seq=0 other
    prefix="${name%%_*}"
    for other in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
        if [ "${other%%_*}" = "$prefix" ]; then
            seq=$((seq + 1))
            [ "$other" = "$name" ] && break
        fi
    done
    echo "$((10#$prefix * 1000 + seq))"
}

migration_prefix() {
    local name="$1"
    echo "$((10#${name%%_*}))"
}

# 本地缓存（离线计划用）：命中即为 0
is_cached() {
    local name="$1"
    if [ -f "$STATE_FILE" ]; then
        grep -Fxq -- "$name" "$STATE_FILE"
    else
        return 1
    fi
}

# 字符串里是否含有某个整行（换行分隔）；避免 grep -q 早退触发 SIGPIPE
line_has() {
    local value="$1" lines="$2"
    if [ -z "$lines" ]; then
        return 1
    fi
    grep -Fxq -- "$value" <<< "$lines"
}

# 从 wrangler --json 载荷里取出某个整数键的全部取值（一行一个）
json_int_values() {
    local payload="$1" key="$2"
    printf '%s' "$payload" \
        | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*[0-9]+" \
        | sed -E 's/^[^0-9]*([0-9]+)$/\1/' || true
}

# 从 wrangler --json 载荷里取出精确的表名集合（一行一个、已排序去重）。
# 精确比较，不做子串匹配：visitors 不能被 visitors_v2 顶替（W3-7）。
json_table_names() {
    local payload="$1"
    printf '%s' "$payload" \
        | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/^"name"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/' \
        | sort -u || true
}

# 对远程 D1 执行一条 SQL；失败时打印 wrangler 的完整输出
d1_execute_sql() {
    local sql="$1" log
    log="$(mktemp -t limooo-d1-sql-XXXXXX.log)"
    if "${WRANGLER_CMD[@]}" d1 execute "$D1_DATABASE_NAME" --remote --command "$sql" >"$log" 2>&1; then
        rm -f "$log"
        return 0
    fi
    echo "FATAL: wrangler d1 execute failed for: $sql" >&2
    cat "$log" >&2
    rm -f "$log"
    return 1
}

if [ "$CHECK_SCHEMA" = 1 ]; then
    expected=(apple_accounts blocked_ips visitors ray_log events visitors_v2 visitor_rollups ray_log_v2 visitors_daily retention_state schema_version blocklist_audit gate_failures)
    if [ -f "$MIGRATIONS_DIR/008_auth_sessions.sql" ] || [ -f "$MIGRATIONS_DIR/004_auth_sessions.sql" ]; then
        expected+=(auth_sessions)
    fi
    echo "[d1] schema check: expected ${expected[*]}"
    if [ "$DRY_RUN" = 1 ]; then
        echo "[d1] dry-run: not connected to D1; the real run reads sqlite_master and validates the tables above."
        exit 0
    fi
    if [ -n "$SCHEMA_JSON_FILE" ]; then
        if [ ! -f "$SCHEMA_JSON_FILE" ]; then
            echo "FATAL: LIMOOO_D1_SCHEMA_JSON file not found: $SCHEMA_JSON_FILE" >&2
            exit 1
        fi
        echo "[d1] schema source: offline payload $SCHEMA_JSON_FILE"
        schema_payload="$(cat "$SCHEMA_JSON_FILE")"
    else
        echo "[d1] schema source: remote D1 ($D1_DATABASE_NAME)"
        schema_log="$(mktemp -t limooo-d1-schema-XXXXXX.log)"
        if schema_payload="$("${WRANGLER_CMD[@]}" d1 execute "$D1_DATABASE_NAME" --remote \
            --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" \
            --json 2>"$schema_log")"; then
            rm -f "$schema_log"
        else
            echo "FATAL: could not read sqlite_master from remote D1 ($D1_DATABASE_NAME)" >&2
            cat "$schema_log" >&2
            rm -f "$schema_log"
            exit 1
        fi
    fi
    table_names="$(json_table_names "$schema_payload")"
    if [ -z "$table_names" ]; then
        echo "FATAL: no table names parsed from the D1 payload (expected sqlite_master JSON with a name field)" >&2
        exit 1
    fi
    echo "[d1] tables in D1: $(printf '%s' "$table_names" | tr '\n' ' ' | sed -E 's/ $//')"
    missing=()
    for table in "${expected[@]}"; do
        if ! grep -Fxq -- "$table" <<< "$table_names"; then
            missing+=("$table")
        fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "FATAL: D1 missing expected tables: ${missing[*]}" >&2
        exit 1
    fi
    echo "[d1] schema check: OK"
    exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
    echo "[d1] dry-run: ${#MIGRATION_NAMES[@]} migration files in order (D1 not contacted)"
    name_width=0
    for name in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
        if [ "${#name}" -gt "$name_width" ]; then
            name_width="${#name}"
        fi
    done
    for name in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
        if is_cached "$name"; then
            cache_label="yes"
        else
            cache_label="no"
        fi
        printf '  %-*s  key=%-6s cache=%s\n' "$name_width" "$name" "$(migration_key "$name")" "$cache_label"
    done
    echo "[d1] cache file (advisory, gitignored): $STATE_FILE"
    echo "[d1] authoritative state: D1 table schema_version (read it with --remote)"
    exit 0
fi

echo "[d1] apply: database=$D1_DATABASE_NAME target=remote files=${#MIGRATION_NAMES[@]}"

# 状态表先建好：它是唯一事实源，读写的都必须是它。
d1_execute_sql "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));" || exit 1

versions_log="$(mktemp -t limooo-d1-versions-XXXXXX.log)"
if versions_raw="$("${WRANGLER_CMD[@]}" d1 execute "$D1_DATABASE_NAME" --remote \
    --command "SELECT version FROM schema_version ORDER BY version" --json 2>"$versions_log")"; then
    rm -f "$versions_log"
else
    echo "FATAL: could not read schema_version from remote D1 ($D1_DATABASE_NAME)" >&2
    cat "$versions_log" >&2
    rm -f "$versions_log"
    exit 1
fi
recorded="$(json_int_values "$versions_raw" version)"
recorded_count=0
if [ -n "$recorded" ]; then
    recorded_count="$(printf '%s\n' "$recorded" | grep -c . || true)"
fi
echo "[d1] schema_version: rows=$recorded_count versions=$(printf '%s' "$recorded" | tr '\n' ',' | sed -E 's/,$//; s/^$/-/')"

applied_names=()
applied=0
skipped=0
for name in "${MIGRATION_NAMES[@]+"${MIGRATION_NAMES[@]}"}"; do
    key="$(migration_key "$name")"
    prefix="$(migration_prefix "$name")"
    if line_has "$key" "$recorded"; then
        echo "[d1] skip (recorded): $name key=$key"
        skipped=$((skipped + 1))
        applied_names+=("$name")
        continue
    fi
    if line_has "$prefix" "$recorded"; then
        echo "[d1] skip (recorded legacy version $prefix): $name key=$key"
        skipped=$((skipped + 1))
        applied_names+=("$name")
        continue
    fi

    echo "[d1] apply: $name key=$key"
    apply_log="$(mktemp -t limooo-d1-apply-XXXXXX.log)"
    if "${WRANGLER_CMD[@]}" d1 execute "$D1_DATABASE_NAME" --remote --file "$MIGRATIONS_DIR/$name" >"$apply_log" 2>&1; then
        rm -f "$apply_log"
    elif grep -Eq 'duplicate column name|already exists' "$apply_log"; then
        # 没记账但 schema 已在（例如 SQL 被手工执行过、或本地状态丢失后重跑）：
        # 明确报「已应用」并补记账，而不是炸在中途（W3-6）。
        echo "[d1] already applied (schema already present, record was missing): $name"
        rm -f "$apply_log"
    else
        echo "FATAL: migration failed: $name" >&2
        cat "$apply_log" >&2
        rm -f "$apply_log"
        exit 1
    fi

    if ! d1_execute_sql "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES ($key, datetime('now'));"; then
        echo "FATAL: could not record $name (key=$key) in schema_version; rerun after fixing D1 access" >&2
        exit 1
    fi
    echo "[d1] recorded: $name key=$key"
    applied=$((applied + 1))
    applied_names+=("$name")
done

# 只有远程执行全部成功之后才刷新本地缓存，且整体覆盖：清掉旧的误记（W3-5）。
mkdir -p "$(dirname "$STATE_FILE")"
cache_tmp="$(mktemp -t limooo-d1-cache-XXXXXX)"
printf '%s\n' "${applied_names[@]+"${applied_names[@]}"}" > "$cache_tmp"
mv "$cache_tmp" "$STATE_FILE"
echo "[d1] plan cache refreshed: $STATE_FILE"

echo "[d1] done: applied=$applied skipped=$skipped"
