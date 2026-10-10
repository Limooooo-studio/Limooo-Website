#!/usr/bin/env bash

# Limooo - Cloudflare Pages build and deploy (docs/17, zero-VPS)
#
# The VPS was retired on 2026-09-17: no ssh, no remote secrets, no rsync.
# Credentials are read from local secrets/webauthn.env only (never committed); the
# token is never written to disk or echoed.
#
# Usage:
#   bash ops/pages_deploy.sh --dry-run      # print what would happen only
#   bash ops/pages_deploy.sh --build-only   # build + validate only, no Cloudflare writes
#   bash ops/pages_deploy.sh                # build + validate + deploy Pages + smoke test
#
# Does not commit or push: that is ops/deploy.sh's job.
#
# This repo lives in an iCloud-synced area, where in-repo node_modules / .venv-build are
# unusable; use the wrangler and venv under /tmp instead (see docs/18-resume.md).

set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_PROJECT="${PAGES_PROJECT:-limooo}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"
SECRETS_FILE="${SECRETS_FILE:-$LOCAL_DIR/secrets/webauthn.env}"

# iCloud 同步区里读大量小文件会卡死；用 /tmp 的隔离构建目录。
PUBLIC_DIR="${LIMOOO_PUBLIC_DIR:-/tmp/limooo-public}"
PREVIEW_DIR="${LIMOOO_PREVIEW_DIR:-/tmp/limooo-preview}"
VENV_PYTHON="${LIMOOO_VENV_PYTHON:-/tmp/limooo-venv/bin/python}"
WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wrangler-env/node_modules/.bin/wrangler}"

DRY_RUN=0
BUILD_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --build-only|--no-deploy) BUILD_ONLY=1 ;;
        --help|-h) sed -n '3,17p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1 (supported: --dry-run / --build-only)" >&2
            exit 2
            ;;
    esac
    shift
done

cd "$LOCAL_DIR"

if [ "$DRY_RUN" = 1 ]; then
    echo "[pages] DRY-RUN: no build, no Cloudflare writes."
    echo "[pages] will-run: $VENV_PYTHON src/build.py   (PUBLIC_DIR=$PUBLIC_DIR)"
    echo "[pages] will-run: check_config_contract.py + check_security_headers.py"
    echo "[pages] will-run: $WRANGLER_BIN pages deploy $PUBLIC_DIR --project-name $PAGES_PROJECT --branch $PAGES_BRANCH"
    echo "[pages] credentials source: ${SECRETS_FILE} (reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID only)"
    exit 0
fi

# ── 构建 ────────────────────────────────────────────────────────────
if [ ! -x "$VENV_PYTHON" ]; then
    echo "FATAL: build venv not found: $VENV_PYTHON" >&2
    echo "       recreate: python3 -m venv /tmp/limooo-venv && /tmp/limooo-venv/bin/pip install -r ops/requirements.txt" >&2
    exit 1
fi

echo "[pages] building (isolated output: ${PUBLIC_DIR})"
LIMOOO_PUBLIC_DIR="$PUBLIC_DIR" LIMOOO_PREVIEW_DIR="$PREVIEW_DIR" "$VENV_PYTHON" src/build.py

if [ ! -f "$PUBLIC_DIR/manifest.json" ]; then
    echo "FATAL: $PUBLIC_DIR/manifest.json missing after build" >&2
    echo "       a half-finished build would publish whatever is in $PUBLIC_DIR;" >&2
    echo "       rerun the build and check the log for the failing step." >&2
    exit 1
fi
# manifest 存在还不够：内容必须与目录里每个文件逐字节对得上（构建之后被手改、
# 多放或漏放的文件都在这里拦下）。同时兜住“构建产物被别的进程改过”这种情况。
LIMOOO_PUBLIC_DIR="$PUBLIC_DIR" "$VENV_PYTHON" src/build.py --verify-manifest
echo "[pages] artifact: $(find "$PUBLIC_DIR" -type f | wc -l | tr -d ' ') files"

# ── 部署前校验 ──────────────────────────────────────────────────────
echo "[pages] validating config contract and security headers"
"$VENV_PYTHON" ops/check_config_contract.py
python3 ops/check_security_headers.py

if [ "$BUILD_ONLY" = 1 ]; then
    echo "[pages] build finished (--build-only), skipping Pages deploy."
    exit 0
fi

# ── 凭据 ────────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
    echo "FATAL: missing $SECRETS_FILE" >&2
    exit 1
fi
if [ ! -x "$WRANGLER_BIN" ]; then
    echo "FATAL: wrangler not found: $WRANGLER_BIN" >&2
    echo "       recreate: mkdir -p /tmp/wrangler-env && cd /tmp/wrangler-env && npm i wrangler@4" >&2
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

# wrangler 自己会往输出里塞 emoji；这里只把 emoji 过滤掉，其余输出原样保留。
strip_emoji() {
    perl -CSD -pe 's/[\x{1F000}-\x{1FAFF}\x{2705}\x{274C}\x{26A0}\x{26C5}\x{2728}\x{2B50}][\x{FE0F}\x{200D}]*\h?//g'
}

# ── 部署 ────────────────────────────────────────────────────────────
# 必须在本目录（site/）执行，否则 wrangler 找不到 functions/，会把整个
# Pages Functions 丢掉（docs/17 §11.6 出过这次事故）。
echo "[pages] deploying Pages (must run under site/, otherwise Functions are dropped)"
export CI=1 WRANGLER_SEND_METRICS=false
"$WRANGLER_BIN" pages deploy "$PUBLIC_DIR" \
    --project-name "$PAGES_PROJECT" \
    --branch "$PAGES_BRANCH" \
    --commit-dirty=true 2>&1 | strip_emoji

# ── 部署后冒烟 ──────────────────────────────────────────────────────
echo "[pages] post-deploy check"
health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://limooo.cn/_health || echo 000)"
if [ "$health" != "200" ]; then
    echo "FATAL: https://limooo.cn/_health = ${health} (expected 200)" >&2
    exit 1
fi
echo "[pages] /_health = 200 OK"
echo "[pages] done. Confirm the log above contains 'Compiled Worker successfully' + 'Uploading Functions bundle'."
