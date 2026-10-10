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

# Limooo - back up portfolio originals to the private Cloudflare R2 bucket.
#
# After A2 the full-size portfolio originals (src/static/portfolio/*) are no longer
# published with Pages: they live only on this machine and in the private R2 bucket
# limooo-originals (git ignores src/static/portfolio/). This script uploads them to
# limooo-originals/portfolio/<file> as an auditable, restorable backup.
#
# Usage:
#   bash ops/upload_originals.sh            # upload (credentials from secrets/webauthn.env)
#   bash ops/upload_originals.sh --dry-run  # print what would run; contact nothing
#
# Credentials: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID come from the local
# secrets/webauthn.env (the same file pages_deploy.sh reads). The VPS was retired on
# 2026-09-17, so no credential is ever fetched from a remote host and no token is echoed.
#
# This repo lives in an iCloud-synced area, where in-repo node_modules is unusable;
# wrangler comes from WRANGLER_BIN (default /tmp/wrangler-env/node_modules/.bin/wrangler).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${R2_BUCKET:-limooo-originals}"
SOURCE_DIR="${R2_SOURCE_DIR:-$ROOT/src/static/portfolio}"
SECRETS_FILE="${SECRETS_FILE:-$ROOT/secrets/webauthn.env}"
WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wrangler-env/node_modules/.bin/wrangler}"
PREFIX="portfolio"

DRY_RUN=0

usage() {
    # 打印文件头注释块（第 3 行起，到第一个非注释行为止），不再写死行号。
    awk 'NR>=3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "FATAL: unknown argument $1 (supported: --dry-run)" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

cd "$ROOT"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "FATAL: missing $SOURCE_DIR" >&2
    exit 1
fi

FILE_COUNT="$(find "$SOURCE_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')"

if [ "$DRY_RUN" = 1 ]; then
    echo "[r2] DRY-RUN: no Cloudflare call, nothing uploaded."
    echo "[r2] source: $SOURCE_DIR ($FILE_COUNT files)"
    echo "[r2] will-run: $WRANGLER_BIN r2 bucket create $BUCKET   (if absent)"
    echo "[r2] will-run: $WRANGLER_BIN r2 object put $BUCKET/$PREFIX/<file> --file <file> --remote"
    echo "[r2] credentials source: ${SECRETS_FILE} (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID only)"
    exit 0
fi

if [ ! -x "$WRANGLER_BIN" ]; then
    echo "FATAL: wrangler not found: $WRANGLER_BIN" >&2
    echo "       recreate: mkdir -p /tmp/wrangler-env && cd /tmp/wrangler-env && npm i wrangler@4" >&2
    exit 1
fi

if [ ! -f "$SECRETS_FILE" ]; then
    echo "FATAL: missing $SECRETS_FILE; cannot read the Cloudflare credentials" >&2
    exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' "$SECRETS_FILE" | tail -1)"
    CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' "$SECRETS_FILE" | tail -1)"
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "FATAL: CLOUDFLARE_API_TOKEN not found in $SECRETS_FILE" >&2
    exit 1
fi

echo "[r2] ensuring bucket $BUCKET exists"
if "$WRANGLER_BIN" r2 bucket list 2>/dev/null | grep -q -w -- "$BUCKET"; then
    echo "[r2] bucket already exists"
else
    "$WRANGLER_BIN" r2 bucket create "$BUCKET"
fi

count=0
while IFS= read -r source; do
    [ -f "$source" ] || continue
    name="$(basename "$source")"
    "$WRANGLER_BIN" r2 object put "$BUCKET/$PREFIX/$name" --file "$source" --remote
    count=$((count + 1))
done < <(find "$SOURCE_DIR" -maxdepth 1 -type f | sort)
echo "[r2] uploaded $count originals to $BUCKET"
