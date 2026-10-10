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

# Local replica of .github/workflows/tests.yml.
#
# Why: CI runs "build first, then typecheck / tests"; running only vitest/pytest
# locally can be all green while CI turns red -- typically when the generated
# functions/_lib/config.ts and src/build.py drift apart (a rename applied on one
# side only), because the local tree happens to be self-consistent while the
# committed tree is not.
#
# So: run this before pushing. Whatever CI runs, this runs.
#
# Usage:
#   bash ops/ci_check.sh                # check the current working tree
#   bash ops/ci_check.sh --ref=<rev>    # check <rev> in a temporary worktree
#                                       # (validates the commit about to be pushed,
#                                       #  even when the working tree is dirty)
#   bash ops/ci_check.sh --typescript   # typescript job only
#   bash ops/ci_check.sh --python       # python job only
#   bash ops/ci_check.sh --no-build     # skip build (assume artifacts are fresh)
#
# Exit code 0 = CI would pass; non-zero = CI would fail, do not push.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF=""
RUN_TS=1
RUN_PY=1
DO_BUILD=1

while [ $# -gt 0 ]; do
    case "$1" in
        --ref=*) REF="${1#--ref=}" ;;
        --typescript) RUN_PY=0 ;;
        --python) RUN_TS=0 ;;
        --no-build) DO_BUILD=0 ;;
        --help|-h) sed -n '20,39p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --ref=<rev> / --typescript / --python / --no-build" >&2
            exit 2
            ;;
    esac
    shift
done

# ── 隔离的构建输出：别在 iCloud 同步区里反复 rm -rf public/ ──────────
export LIMOOO_PUBLIC_DIR="${LIMOOO_PUBLIC_DIR:-/tmp/limooo-ci-public}"
export LIMOOO_PREVIEW_DIR="${LIMOOO_PREVIEW_DIR:-/tmp/limooo-ci-preview}"

# Python 解释器：优先用构建 venv（依赖齐），其次 python3。
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [ -x "$ROOT/.venv-build/bin/python" ]; then
    PYTHON_BIN="$ROOT/.venv-build/bin/python"
fi

WORKTREE=""
cleanup() {
    if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
        git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
    fi
}
trap cleanup EXIT

# ── 选定要检查的树 ──────────────────────────────────────────────────
TARGET="$ROOT"
if [ -n "$REF" ]; then
    if ! git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
        echo "FATAL: not a commit: $REF" >&2
        exit 2
    fi
    WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/limooo-ci-check.XXXXXX")"
    # git worktree add 要求目录为空或不存在
    rmdir "$WORKTREE"
    git worktree add --detach "$WORKTREE" "$REF" >/dev/null
    # 复用主仓库的依赖，避免在临时目录里重新装一遍
    [ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$WORKTREE/node_modules"
    [ -d "$ROOT/.venv-build" ] && ln -s "$ROOT/.venv-build" "$WORKTREE/.venv-build"
    TARGET="$WORKTREE"
    echo "[ci] checking ref $REF (tree at $TARGET)"
else
    echo "[ci] checking working tree at $ROOT"
fi

# ── 守卫 1：iCloud 冲突副本（"build 2.py" 这类）绝不能进仓库 ─────────
CONFLICTS="$(cd "$TARGET" && find functions src locales tests ops .github \
    \( -name node_modules -o -name .venv-build -o -name .wrangler \
       -o -name out -o -name kuma-dist \) -prune -o \
    -type f \( -name '* [0-9]' -o -name '* [0-9].*' \) -print 2>/dev/null | sort)"
if [ -n "$CONFLICTS" ]; then
    echo "[ci] FAIL: iCloud conflict copies detected ('xxx 2.ext'); resolve them before committing:" >&2
    echo "$CONFLICTS" | head -20 | sed 's/^/       /' >&2
    echo "       once confirmed identical to the original, delete: rm -f 'functions/_data/runtime 2.ts' ..." >&2
    exit 1
fi

# ── 守卫 2：敏感文件绝不能被提交 ────────────────────────────────────
# 背景：checkout 里如果缺少 .gitignore（新 clone / AI 工具自动开的 worktree），
# `git add -A` 会把 secrets/、*.db、*.pem 一并提交。.gitignore 现已入库，但
# 守卫仍然必需：`git add -f` 和「先 add 后改规则」都能绕过它。
#
# 检查两个来源：已暂存（staged）+ 未被忽略且未跟踪（untracked）。
# --directory 把整个被忽略目录折叠成一行，既省输出也避免逐文件刷屏。
# 模式清单与仓库根 .gitignore 的敏感段落对应，改一边记得改另一边。
SENSITIVE_PATTERNS=(
    'secrets/*' '.dev.vars' '*.db' '*.db-shm' '*.db-wal' '*.pem' '*.key'
    'ops/out/*' 'ops/backups/*' 'backup-limooo-*' '各种密钥.txt' '*.mmdb'
)

sensitive_paths() {
    {
        (cd "$TARGET" && git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
        (cd "$TARGET" && git ls-files --others --exclude-standard --directory 2>/dev/null || true)
    } | sort -u
}

match_sensitive_path() {
    local path="$1" pattern
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
        # shellcheck disable=SC2254 # 这里就是要让 pattern 参与通配匹配
        case "$path" in $pattern) return 0 ;; esac
    done
    return 1
}

SENSITIVE_HITS=""
while IFS= read -r path; do
    [ -n "$path" ] || continue
    if match_sensitive_path "$path"; then
        SENSITIVE_HITS="${SENSITIVE_HITS}${path}"$'\n'
    fi
done < <(sensitive_paths)

if [ -n "$SENSITIVE_HITS" ]; then
    echo "[ci] FAIL: sensitive files would be committed:" >&2
    printf '%s' "$SENSITIVE_HITS" | sed 's/^/       /' >&2
    echo "       remove them from the index (git restore --staged <path>) or add an ignore rule;" >&2
    echo "       secrets/ and *.db must never enter the repository." >&2
    exit 1
fi

# ── 守卫 3：生成的 TS 产物必须由 build 现场再生，且与仓库一致 ────────
# build 之后如果 functions/_lib/config.ts、functions/_data/*.ts、
# src/config.py 相对 HEAD 有差异，说明提交时忘了带上它们 —— 这正是 CI 变红的根因。
GENERATED_PATHS=(functions/_lib/config.ts functions/_data src/config.py)

echo "[ci] typescript job"
if [ "$RUN_TS" = 1 ]; then
    if [ ! -d "$TARGET/node_modules" ]; then
        echo "[ci] FAIL: $TARGET/node_modules is missing; run npm ci first" >&2
        exit 1
    fi

    if [ "$DO_BUILD" = 1 ]; then
        echo "[ci] npm run build"
        (cd "$TARGET" && npm run build)
    fi

    if [ -n "$REF" ]; then
        drift="$(cd "$TARGET" && git status --porcelain -- "${GENERATED_PATHS[@]}" 2>/dev/null || true)"
        if [ -n "$drift" ]; then
            echo "[ci] FAIL: generated artifacts in $REF do not match src/build.py + config-contract.json:" >&2
            echo "$drift" | sed 's/^/       /' >&2
            echo "       commit the generator sources you changed (src/build.py / config-contract.json / locales/) as well." >&2
            exit 1
        fi
    fi

    echo "[ci] npm run typecheck"
    (cd "$TARGET" && npm run typecheck)

    echo "[ci] bash ops/migrate_d1.sh --dry-run"
    (cd "$TARGET" && bash ops/migrate_d1.sh --dry-run)

    echo "[ci] npm test"
    (cd "$TARGET" && npm test)
fi

if [ "$RUN_PY" = 1 ]; then
    echo "[ci] python job"
    echo "[ci] python -m pytest"
    (cd "$TARGET" && "$PYTHON_BIN" -m pytest -q)
fi

echo "[ci] OK: CI will pass."
