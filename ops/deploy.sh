#!/bin/bash

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

# limooo.cn deploy entrypoint (docs/17, zero-VPS) -- the SINGLE deploy script.
#
# The VPS was retired on 2026-09-17: no ssh, no rsync, no remote restart, no nginx.
# Full deploy = (1) git commit -> (2) git push -> (3) Cloudflare Pages (+ related Workers).
#
# Usage:
#   bash ops/deploy.sh                          # = --all (commit + push + Pages + docs)
#   bash ops/deploy.sh --all                    # commit + push + deploy Pages + docs
#   bash ops/deploy.sh --dry-run                # print what would happen only
#   bash ops/deploy.sh --commit                 # commit only
#   bash ops/deploy.sh --commit --push          # commit and push
#   bash ops/deploy.sh --pages                  # deploy the main Pages project only
#   bash ops/deploy.sh --docs                   # build + deploy docs.limooo.cn only
#   bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker only
#   bash ops/deploy.sh --full ...               # same flags, but stream every step's output
#
# Default output is QUIET: each step prints one status line, and a step's full log
# is only dumped when that step fails. Pass --full (or set LIMOOO_DEPLOY_VERBOSE=1)
# to stream the build manifest, artifact count and wrangler upload progress.
#
# With NO arguments this is exactly --all: commit + push + Pages + docs, matching the
# "full deploy" contract in AGENTS.md. To ship only what is already committed locally,
# pass --pages / --docs explicitly.
#
# Before commit / push this runs ops/ci_check.sh (a local replica of
# .github/workflows/tests.yml): build first, then typecheck / tests. Any failure
# aborts, so nothing is committed or pushed. Emergency skip:
#   LIMOOO_SKIP_CHECKS=1 bash ops/deploy.sh --all
#
# Environment:
#   LIMOOO_DEPLOY_VERBOSE=1   same as --full
#   LIMOOO_SKIP_DOCS=1        drop the docs.limooo.cn step
#   LIMOOO_SKIP_CHECKS=1      skip the local CI replica before commit / push
#   LIMOOO_GIT_FILE_LIST_LIMIT=N  max file names printed per commit (default 20)
# Credentials are read from local secrets/webauthn.env; never written to disk or echoed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_COMMIT=0
DO_PUSH=0
DO_PAGES=0
DO_DOCS=0
WORKER=""
DRY_RUN=0
VERBOSE="${LIMOOO_DEPLOY_VERBOSE:-0}"
# 提交时最多列出多少个文件名，超出只报剩余数量（避免一次提交刷屏）
GIT_FILE_LIST_LIMIT="${LIMOOO_GIT_FILE_LIST_LIMIT:-20}"

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --commit) DO_COMMIT=1 ;;
        --push) DO_PUSH=1 ;;
        --pages) DO_PAGES=1 ;;
        --docs) DO_DOCS=1 ;;
        --all) DO_COMMIT=1; DO_PUSH=1; DO_PAGES=1; DO_DOCS=1 ;;
        --full) VERBOSE=1 ;;
        --worker=*) WORKER="${1#--worker=}" ;;
        --help|-h) sed -n '20,53p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --dry-run / --commit / --push / --pages / --docs / --all / --full / --worker=<name>" >&2
            exit 2
            ;;
    esac
    shift
done

# 不带任何参数 = --all（commit + push + Pages + docs），与 AGENTS.md 的「完整部署」语义一致
if [ "$DO_COMMIT" = 0 ] && [ "$DO_PUSH" = 0 ] && [ "$DO_PAGES" = 0 ] && [ "$DO_DOCS" = 0 ] && [ -z "$WORKER" ]; then
    DO_COMMIT=1
    DO_PUSH=1
    DO_PAGES=1
    DO_DOCS=1
fi

if [ "${LIMOOO_SKIP_DOCS:-0}" = 1 ]; then
    DO_DOCS=0
fi

# 跑一个子步骤。两种模式：
#   安静（默认）：输出收进临时日志，成功只打一行 "<tag>: done"，
#                 失败打 "<tag>: FAILED -- full log follows" 并把完整日志吐到 stderr。
#   --full      ：先回显要跑的命令，再原样透传它的输出，不额外加状态行。
# 用法：run_step "<标签>" <命令...>
run_step() {
    local tag="$1"; shift
    if [ "$VERBOSE" = 1 ]; then
        echo "$*"
        "$@"
        return
    fi
    local log
    log="$(mktemp -t limooo-deploy-XXXXXX.log)"
    if "$@" >"$log" 2>&1; then
        rm -f "$log"
        echo "$tag: done"
    else
        echo "$tag: FAILED -- full log follows" >&2
        cat "$log" >&2
        rm -f "$log"
        return 1
    fi
}

if [ "$DRY_RUN" = 1 ]; then
    echo "Deploy start (dry-run)"
    [ "$DO_COMMIT" = 1 ] && echo "  would-run: git add -A && git commit"
    [ "$DO_PUSH" = 1 ] && echo "  would-run: git push origin main"
    { [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; } && echo "  would-run: bash ops/ci_check.sh"
    [ "$DO_PAGES" = 1 ] && echo "  would-run: bash ops/pages_deploy.sh"
    [ "$DO_DOCS" = 1 ] && echo "  would-run: bash ops/docs_deploy.sh"
    [ -n "$WORKER" ] && echo "  would-run: bash ops/workers_deploy.sh --worker=$WORKER"
    echo "Deploy: dry-run done"
    exit 0
fi

echo "Deploy start"

# ── ⓪ 本地 CI 复刻（必须先于 commit / push）──────────────────────────
# 历史教训：CI 是「先 build 再 typecheck / 测试」，而本地只跑过 vitest/pytest，
# 于是「本地全绿、push 完 30 秒收到失败通知」。这里把 CI 原样跑一遍。
if [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; then
    if [ "${LIMOOO_SKIP_CHECKS:-0}" = 1 ]; then
        echo "Check: skipped (LIMOOO_SKIP_CHECKS=1)"
    elif [ "$DO_COMMIT" = 1 ]; then
        run_step "Check" bash ops/ci_check.sh
    else
        run_step "Check" bash ops/ci_check.sh --ref=HEAD
    fi
fi

# --full 下回显要跑的命令；安静模式下不打扰（git 本来就无声）
show_cmd() {
    [ "$VERBOSE" = 1 ] && echo "$*"
    return 0
}

# ── ① git commit ────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ]; then
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Warning: not a git work tree, skipped commit" >&2
    else
        show_cmd git add -A -- . ':!limooo.cn.png'
        git add -A -- . ':!limooo.cn.png'
        if git diff --cached --quiet; then
            echo "Git: nothing to commit"
        else
            echo "Git: committing"
            # 列出本次提交涉及的文件（两空格缩进，见 AGENTS.md 的输出约定）
            staged_files="$(git diff --cached --name-only)"
            staged_total=0
            [ -n "$staged_files" ] && staged_total="$(printf '%s\n' "$staged_files" | wc -l | tr -d ' ')"
            staged_shown=0
            while IFS= read -r path; do
                [ -z "$path" ] && continue
                [ "$staged_shown" -ge "$GIT_FILE_LIST_LIMIT" ] && break
                echo "  $path"
                staged_shown=$((staged_shown + 1))
            done <<< "$staged_files"
            if [ "$staged_total" -gt "$staged_shown" ]; then
                echo "  ... and $((staged_total - staged_shown)) more"
            fi
            show_cmd git commit -m "deploy: auto-commit <timestamp>"
            git commit -m "deploy: auto-commit $(date '+%Y-%m-%d %H:%M')" >/dev/null
        fi
        # 刚提交的这棵树就是 ⓪ 里检查过的内容，pre-push hook 不必再跑一遍。
        export LIMOOO_CI_CHECKED_SHA="$(git rev-parse HEAD)"
    fi
fi

# ── ② git push ──────────────────────────────────────────────────────
if [ "$DO_PUSH" = 1 ]; then
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Warning: not a git work tree, skipped push" >&2
    elif ! git fetch origin main >/dev/null 2>&1; then
        echo "Warning: could not fetch GitHub state, skipped push" >&2
    else
        LOCAL_HEAD="$(git rev-parse HEAD)"
        REMOTE_HEAD="$(git rev-parse origin/main)"
        if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
            echo "Git: GitHub already up to date, skipped push"
        elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
            show_cmd git push origin main
            if git push origin main >/dev/null 2>&1; then
                echo "Git: Push to GitHub"
            else
                echo "Warning: git push failed, continuing deploy" >&2
            fi
        else
            # 分叉必须人工处理：自动 rebase/merge 会把别人的提交卷进这次部署
            echo "FATAL: local and GitHub histories diverged, resolve manually (rebase/merge) first" >&2
            exit 1
        fi
    fi
fi

# ── ③ Pages：只在失败时吐出日志，成功时只留一行状态 ─────────────────
if [ "$DO_PAGES" = 1 ]; then
    # pages_deploy.sh 自己会在结束前校验 /_health = 200，失败即非 0 退出
    run_step "Pages" bash ops/pages_deploy.sh
fi

# ── ③b docs.limooo.cn（独立 Pages 项目 limooo-docs）─────────────────
if [ "$DO_DOCS" = 1 ]; then
    # docs_deploy.sh 自己会对各语言路径做冒烟，失败即非 0 退出
    run_step "Docs" bash ops/docs_deploy.sh
fi

# ── ④ 独立 Worker（可选，与 Pages 互不影响）─────────────────────────
if [ -n "$WORKER" ]; then
    run_step "Worker: $WORKER" bash ops/workers_deploy.sh "--worker=$WORKER"
fi

echo "Deploy: done"
