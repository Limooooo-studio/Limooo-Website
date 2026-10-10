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

# Limooo - deploy the standalone Cloudflare Workers through one entry point.
#
# Covers:
#   - ops/sync-worker       (D1 blocked_ips -> Cloudflare IP List, cron 03:30)
#   - ops/image-watermark   (image.limooo.cn watermark route)
#   - ops/d1-archive        (D1 export archive worker)
#   - ops/status-worker     (probes / status page / alerts / D1 retention)
#
# Usage:
#   bash ops/workers_deploy.sh --dry-run                 # print the exact commands, run nothing
#   bash ops/workers_deploy.sh                           # deploy every Worker above
#   bash ops/workers_deploy.sh --worker=status-worker    # deploy one Worker
#
# Credentials: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment,
# else from the local secrets/webauthn.env (the same file pages_deploy.sh reads).
# The token is never echoed and never written to the repository.
#
# This repo lives in an iCloud-synced area, where in-repo node_modules is unusable;
# wrangler comes from WRANGLER_BIN (default /tmp/wrangler-env/node_modules/.bin/wrangler).
#
# The command printed for each Worker is exactly the command that runs, including
# `--config <dir>/wrangler.toml`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wrangler-env/node_modules/.bin/wrangler}"
SECRETS_FILE="${SECRETS_FILE:-$ROOT/secrets/webauthn.env}"
DRY_RUN=0
SELECTED=""

usage() {
    # 打印文件头注释块（第 3 行起，到第一个非注释行为止），不再写死行号。
    awk 'NR>=3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --worker=*) SELECTED="${1#--worker=}" ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1 (supported: --dry-run / --worker=<name>)" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if ! command -v git >/dev/null 2>&1; then
    echo "FATAL: git is required to record the current commit" >&2
    exit 1
fi

WORKERS=("$ROOT/ops/sync-worker" "$ROOT/ops/image-watermark" "$ROOT/ops/d1-archive" "$ROOT/ops/status-worker")
if [ -n "$SELECTED" ]; then
    case "$SELECTED" in
        sync-worker|image-watermark|d1-archive|status-worker) WORKERS=("$ROOT/ops/$SELECTED") ;;
        *)
            echo "FATAL: unknown Worker $SELECTED (available: sync-worker / image-watermark / d1-archive / status-worker)" >&2
            exit 2
            ;;
    esac
fi

COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"
printf '%-24s %s %s\n' "commit" "$COMMIT" "dirty_files=$DIRTY"

# wrangler 自己会往输出里塞 emoji；这里只把 emoji 过滤掉，其余输出原样保留。
strip_emoji() {
    perl -CSD -pe 's/[\x{1F000}-\x{1FAFF}\x{2705}\x{274C}\x{26A0}\x{26C5}\x{2728}\x{2B50}][\x{FE0F}\x{200D}]*\h?//g'
}

if [ "$DRY_RUN" = 1 ]; then
    echo "[workers] DRY-RUN: no wrangler call, nothing deployed."
    for dir in "${WORKERS[@]}"; do
        config="$dir/wrangler.toml"
        if [ ! -f "$config" ]; then
            echo "FATAL: missing $config" >&2
            exit 1
        fi
        echo "[workers] $(basename "$dir")"
        echo "  will-run: (cd $dir && $WRANGLER_BIN deploy --config $config)"
    done
    echo "[workers] credentials source: ${SECRETS_FILE} (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID only)"
    exit 0
fi

if [ ! -x "$WRANGLER_BIN" ]; then
    echo "FATAL: wrangler not found: $WRANGLER_BIN" >&2
    echo "       recreate: mkdir -p /tmp/wrangler-env && cd /tmp/wrangler-env && npm i wrangler@4" >&2
    exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    if [ ! -f "$SECRETS_FILE" ]; then
        echo "FATAL: missing $SECRETS_FILE and CLOUDFLARE_API_TOKEN is not in the environment" >&2
        exit 1
    fi
    CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$SECRETS_FILE" | tail -1)"
    CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' "$SECRETS_FILE" | tail -1)"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "FATAL: CLOUDFLARE_API_TOKEN not found in $SECRETS_FILE" >&2
    exit 1
fi

for dir in "${WORKERS[@]}"; do
    config="$dir/wrangler.toml"
    if [ ! -f "$config" ]; then
        echo "FATAL: missing $config" >&2
        exit 1
    fi
    echo "[workers] $(basename "$dir"): (cd $dir && $WRANGLER_BIN deploy --config $config)"
    (cd "$dir" && "$WRANGLER_BIN" deploy --config "$config" 2>&1 | strip_emoji)
done

echo "[workers] done"
