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
# Step set (identical to .github/workflows/tests.yml -- keep both in sync):
#   typescript: build / typecheck / migrate --dry-run / npm test / coverage (report only)
#   python:     ruff / mypy / pytest / security headers / license headers / readme_facts.py --check
#
# ruff and mypy are probed, not required (same treatment as pytest-cov):
# installed -> run and fail the gate; missing -> one [ci] SKIP line, no failure.
# Why probe: they live in ops/requirements.txt but the build venv may predate them.
#
# Build output isolation: LIMOOO_PUBLIC_DIR / LIMOOO_PREVIEW_DIR point the build at a
# scratch dir instead of the iCloud-synced tree. Export them to pin the location: the
# value is used exactly as given and is never removed. Left unset, every run gets its
# own mktemp -d directory (removed on exit), so two concurrent runs cannot delete each
# other's files mid-build.
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
        # 帮助文本就是文件顶部那段注释（"# Local replica" 到 "set -euo pipefail" 之前）。
        # 故意不写死行号：注释一增删，sed 的固定区间就会**悄悄**截断帮助文本。
        --help|-h)
            awk '/^# Local replica/,/^set -euo pipefail/' "$0" | sed '$d'
            exit 0
            ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --ref=<rev> / --typescript / --python / --no-build" >&2
            exit 2
            ;;
    esac
    shift
done

# ── 隔离的构建输出：别在 iCloud 同步区里反复 rm -rf public/ ──────────
# 默认路径必须**每进程唯一**：两个 ci_check.sh 并发时，build.py 开头的 rmtree 会
# 互删对方的中转目录（Errno 66 Directory not empty / FileNotFoundError），审计期间
# 已经因此浪费了两个代理的排查时间。显式传入时行为完全不变——沿用传入值、不做
# 唯一化、退出时也绝不删（那是调用方的目录，不是本进程的临时目录）。
CI_TMP_PUBLIC=""
CI_TMP_PREVIEW=""
# TMPDIR 在 macOS 上以 / 结尾，直接拼会写出 "//" —— 去掉尾斜杠只为输出干净。
SCRATCH_ROOT="${TMPDIR:-/tmp}"
SCRATCH_ROOT="${SCRATCH_ROOT%/}"
if [ -z "${LIMOOO_PUBLIC_DIR:-}" ]; then
    LIMOOO_PUBLIC_DIR="$(mktemp -d "$SCRATCH_ROOT/limooo-ci-public.XXXXXX")" || {
        echo "FATAL: cannot create a temporary public dir under $SCRATCH_ROOT" >&2
        exit 2
    }
    CI_TMP_PUBLIC="$LIMOOO_PUBLIC_DIR"
fi
if [ -z "${LIMOOO_PREVIEW_DIR:-}" ]; then
    LIMOOO_PREVIEW_DIR="$(mktemp -d "$SCRATCH_ROOT/limooo-ci-preview.XXXXXX")" || {
        echo "FATAL: cannot create a temporary preview dir under $SCRATCH_ROOT" >&2
        exit 2
    }
    CI_TMP_PREVIEW="$LIMOOO_PREVIEW_DIR"
fi
export LIMOOO_PUBLIC_DIR LIMOOO_PREVIEW_DIR
if [ -n "$CI_TMP_PUBLIC" ] || [ -n "$CI_TMP_PREVIEW" ]; then
    echo "[ci] scratch dirs: public=$LIMOOO_PUBLIC_DIR preview=$LIMOOO_PREVIEW_DIR (temporary, removed on exit)"
fi

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
    # 只删本进程 mktemp 出来的目录（显式传入的路径不归我们管，见上）。
    # 用 if 而不是 `[ -n x ] && rm`：后者条件为假时返回 1，set -e 下的 EXIT trap
    # 不该让清理逻辑本身变成失败来源。
    if [ -n "$CI_TMP_PUBLIC" ]; then
        rm -rf "$CI_TMP_PUBLIC"
    fi
    if [ -n "$CI_TMP_PREVIEW" ]; then
        rm -rf "$CI_TMP_PREVIEW"
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

# ── 守卫 1：iCloud 冲突副本（"build 2.py" / ".venv-build 2" 这类）────
# 冲突副本既可以是文件，也可以是**整个目录**——iCloud 把 `site/.venv-build`
# 复制成 `site/.venv-build 2` 时只有目录名带序号，`-type f` 永远看不到它。
# 所以这里用 `\( -type f -o -type d \)` 同时扫，模式统一放在 -name 列表里。
# 剪枝只针对**正本**目录名（node_modules/.venv-build/...），带序号的副本不在
# 剪枝名单内，否则又会把它们跳过——这正是旧写法的洞。
CONFLICTS="$(cd "$TARGET" && find functions src locales tests ops .github \
    \( -type d \( -name node_modules -o -name .venv-build -o -name .wrangler \
       -o -name out -o -name coverage -o -name .pytest_cache -o -name .ruff_cache \
       -o -name __pycache__ \) \) -prune -o \
    \( -type f -o -type d \) \( -name '* [0-9]' -o -name '* [0-9].*' \) -print 2>/dev/null | sort)"
if [ -n "$CONFLICTS" ]; then
    echo "[ci] FAIL: iCloud conflict copies detected ('xxx 2.ext' / 'xxx 2'); resolve them before committing:" >&2
    echo "$CONFLICTS" | head -20 | sed 's/^/       /' >&2
    echo "       once confirmed identical to the original:" >&2
    echo "         rm -f 'functions/_data/runtime 2.ts'" >&2
    echo "         rm -rf '.venv-build 2' 'node_modules.recovery-20260912-0145'" >&2
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

    # 覆盖率只报告、不设阈值（W6-3），**这一步永远不决定 CI 成败**：
    #   - 缺 @vitest/coverage-v8 → 跳过（提示装依赖）；
    #   - 测试失败时 vitest 不输出覆盖率报告 → 上面 `npm test` 已经拦下了，
    #     这里再报一次「覆盖率没跑成」只会掩盖真正的失败点；
    #   - vitest 第二次跑（带 v8 插桩）可能与第一次读数不同（同一进程里的
    #     模块状态），把这种差异算成闸门失败会变成随机红。
    # 刻意不写 `if ! npm run ...` —— 那会把 exit 1 变成 0，掩盖真正的失败。
    if [ ! -d "$TARGET/node_modules/@vitest/coverage-v8" ]; then
        echo "[ci] SKIP coverage: @vitest/coverage-v8 is not installed (npm ci first)"
    else
        echo "[ci] npm run test:coverage (report only, no threshold)"
        set +e +o pipefail
        (cd "$TARGET" && npm run test:coverage) || echo "[ci] coverage report unavailable (see the npm test step above for the real result)"
        set -eo pipefail
    fi
fi

if [ "$RUN_PY" = 1 ]; then
    echo "[ci] python job"

    # ruff / mypy 与 pytest-cov 同一套探测式处理：装了就跑、没装只打印一行 SKIP。
    # 它们不是运行时依赖（在 ops/requirements.txt 里，不在 requirements.lock），
    # 老 venv 里没有是正常状态，不该因此把闸门判红。
    if (cd "$TARGET" && "$PYTHON_BIN" -m ruff --version >/dev/null 2>&1); then
        echo "[ci] python -m ruff check src ops tests"
        (cd "$TARGET" && "$PYTHON_BIN" -m ruff check src ops tests)
    else
        echo "[ci] SKIP ruff: not installed (pip install -r ops/requirements.txt)"
    fi

    if (cd "$TARGET" && "$PYTHON_BIN" -m mypy --version >/dev/null 2>&1); then
        echo "[ci] python -m mypy src"
        (cd "$TARGET" && "$PYTHON_BIN" -m mypy src)
    else
        echo "[ci] SKIP mypy: not installed (pip install -r ops/requirements.txt)"
    fi

    echo "[ci] python -m pytest"
    # 覆盖率只报告、不设阈值（W6-3）。pytest-cov 不在 requirements.lock 里，
    # 所以先探测再决定加不加 --cov；缺了只跳过且不影响退出码。
    if (cd "$TARGET" && "$PYTHON_BIN" -c 'import pytest_cov' >/dev/null 2>&1); then
        (cd "$TARGET" && "$PYTHON_BIN" -m pytest -q --cov=src --cov-report=term-missing)
    else
        echo "[ci] SKIP coverage: pytest-cov is not installed (pip install pytest-cov)"
        (cd "$TARGET" && "$PYTHON_BIN" -m pytest -q)
    fi
    echo "[ci] python ops/check_security_headers.py"
    (cd "$TARGET" && "$PYTHON_BIN" ops/check_security_headers.py)
    echo "[ci] python ops/check_license_headers.py"
    (cd "$TARGET" && "$PYTHON_BIN" ops/check_license_headers.py)
    echo "[ci] python ops/readme_facts.py --check"
    (cd "$TARGET" && "$PYTHON_BIN" ops/readme_facts.py --check)
fi

echo "[ci] OK: CI will pass."
