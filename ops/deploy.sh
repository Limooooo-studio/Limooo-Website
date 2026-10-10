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
#   bash ops/deploy.sh -m "fix: thing"          # commit with message "deploy: fix: thing"
#   bash ops/deploy.sh --message="fix: thing"   # same, long form
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
# commit / push require the current branch to be "main": this script compares HEAD with
# origin/main but pushes refs/heads/main, so on a feature branch the commit would land
# on the feature branch while the edge got built from a tree GitHub never saw. Any
# other branch (including a detached HEAD) aborts with FATAL (exit 2).
#
# --pages and --docs build the WORKING TREE, so they run ops/ci_check.sh first and
# refuse to deploy when the tree has uncommitted changes. Emergency override:
#   LIMOOO_ALLOW_DIRTY=1 bash ops/deploy.sh --pages
#
# --worker= needs a non-empty Worker name: an empty value used to fall through to the
# "no arguments = --all" branch and silently became a full deploy. It is rejected with
# FATAL (exit 2).
#
# Before commit / push this runs ops/ci_check.sh (a local replica of
# .github/workflows/tests.yml): build first, then typecheck / tests. Any failure
# aborts, so nothing is committed or pushed. The checks run against the STAGED tree
# (git add happens first) and the staged tree hash is compared before committing, so
# a file changed by another tool during the checks cannot slip in unchecked.
# Emergency skip:
#   LIMOOO_SKIP_CHECKS=1 bash ops/deploy.sh --all
#
# A failed git push aborts BEFORE the Pages deploy (never let the edge run ahead of
# GitHub). Emergency override:
#   LIMOOO_ALLOW_PUSH_FAIL=1 bash ops/deploy.sh --all
#
# Environment:
#   LIMOOO_DEPLOY_VERBOSE=1   same as --full
#   LIMOOO_SKIP_DOCS=1        drop the docs.limooo.cn step
#   LIMOOO_SKIP_CHECKS=1      skip the local CI replica before commit / push / Pages / docs
#   LIMOOO_ALLOW_DIRTY=1      deploy --pages / --docs with a dirty working tree
#   LIMOOO_ALLOW_PUSH_FAIL=1  deploy even when git push fails (emergency only)
#   LIMOOO_GIT_FILE_LIST_LIMIT=N  max file names printed per commit (default 20)
# Credentials are read from local secrets/webauthn.env; never written to disk or echoed.
# END-USAGE

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_COMMIT=0
DO_PUSH=0
DO_PAGES=0
DO_DOCS=0
WORKER=""
DRY_RUN=0
COMMIT_MESSAGE=""
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
        --worker=*)
            WORKER="${1#--worker=}"
            # 空值（`--worker=$W` 且 $W 为空）会让下面的"无参数 = --all"分支成立，
            # 静默变成 commit + push + Pages + docs 的完整部署（W3-2）。
            if [ -z "$WORKER" ]; then
                echo "FATAL: --worker= needs a Worker name (for example --worker=status-worker)" >&2
                exit 2
            fi
            case "$WORKER" in
                *[!A-Za-z0-9._-]*)
                    echo "FATAL: invalid Worker name '$WORKER' (allowed: letters, digits, dot, underscore, hyphen)" >&2
                    exit 2
                    ;;
            esac
            ;;
        --message=*) COMMIT_MESSAGE="${1#--message=}" ;;
        -m)
            if [ $# -lt 2 ]; then
                echo "FATAL: -m requires a commit message" >&2
                exit 2
            fi
            COMMIT_MESSAGE="$2"
            shift
            ;;
        -m*) COMMIT_MESSAGE="${1#-m}" ;;
        --help|-h) sed -n '/^# Usage:/,/^# END-USAGE/p' "$0"; exit 0 ;;
        *)
            echo "FATAL: unknown argument $1" >&2
            echo "       supported: --dry-run / --commit / --push / --pages / --docs / --all / --full / -m <msg> / --message=<msg> / --worker=<name>" >&2
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

# ── ⓪0 分支断言：commit / push 只能在 main 上做（W3-1）───────────────
# 历史 bug：脚本比的是 HEAD、推的却是 refs/heads/main。在特性分支上跑完整部署时，
# 提交进特性分支 → push main（通常 no-op，却仍打印 "pushed"）→ 随后用**特性分支的
# 工作树**构建 Pages：边缘于是跑在 GitHub 前面，正好破坏本脚本自己的顺序保证。
# 断言放在 --dry-run 之前：dry-run 也要如实报出「这条路走不通」。
IN_GIT_TREE=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    IN_GIT_TREE=1
fi
CURRENT_BRANCH=""
if [ "$IN_GIT_TREE" = 1 ]; then
    CURRENT_BRANCH="$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
BRANCH_LABEL="$CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" = "HEAD" ]; then
    BRANCH_LABEL="detached HEAD"
elif [ -z "$CURRENT_BRANCH" ]; then
    BRANCH_LABEL="unknown"
fi

if [ "$IN_GIT_TREE" = 1 ] && { [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; }; then
    if [ "$CURRENT_BRANCH" != "main" ]; then
        echo "FATAL: commit/push must run on branch main (current: $BRANCH_LABEL)" >&2
        echo "       switch to main first (git switch main) and rerun; this script pushes refs/heads/main only" >&2
        exit 2
    fi
fi

# Pages / docs / Worker 也从当前分支的工作树构建，非 main 时至少要说清后果（不阻断）。
if [ "$IN_GIT_TREE" = 1 ] && [ "$CURRENT_BRANCH" != "main" ] \
    && { [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ] || [ -n "$WORKER" ]; }; then
    echo "Warning: not on branch main (current: $BRANCH_LABEL); this deploys a tree GitHub does not have yet"
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
    echo "Deploy: start (dry-run)"
    [ "$IN_GIT_TREE" = 1 ] && echo "  branch: $BRANCH_LABEL"
    [ "$DO_COMMIT" = 1 ] && echo "  would-run: git add -A && git commit"
    [ "$DO_PUSH" = 1 ] && echo "  would-run: git push origin main"
    { [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ]; } && echo "  requires: branch main (FATAL exit 2 on any other branch)"
    { [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ] || [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ]; } && echo "  would-run: bash ops/ci_check.sh (skip with LIMOOO_SKIP_CHECKS=1)"
    [ "$DO_PAGES" = 1 ] && echo "  would-run: bash ops/pages_deploy.sh"
    [ "$DO_DOCS" = 1 ] && echo "  would-run: bash ops/docs_deploy.sh"
    { [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ]; } && echo "  requires: clean working tree (override with LIMOOO_ALLOW_DIRTY=1)"
    [ -n "$WORKER" ] && echo "  would-run: bash ops/workers_deploy.sh --worker=$WORKER"
    echo "Deploy: dry-run done"
    exit 0
fi

echo "Deploy: start"

# --full 下回显要跑的命令；安静模式下不打扰（git 本来就无声）
show_cmd() {
    [ "$VERBOSE" = 1 ] && echo "$*"
    return 0
}

# ── ⓪a 先入暂存区，再跑检查（检查必须针对将要提交的那棵树）──────────
# 顺序很重要：原先是「先检查、后 git add -A」，检查与提交之间只要有任何工具
# 改过文件，提交内容就不等于检查过的内容。现在先 stage，再取一次**工作区快照**
# （见 ⓪c），检查完重算比对。git add 正常无输出，不需要 run_step 包一层。
#
# 快照怎么取（踩过两次坑，别换回更"简单"的写法）：
#   * git write-tree —— 不行：它只算**索引**，检查期间被改的文件通常没重新
#     stage，索引不变、树哈希也不变，等于检测不到。
#   * git stash create —— 不行：它的哈希包含**索引**状态，而 ⓪a 的 git add 会让
#     「未暂存」变成「已暂存」，同一份内容算出两个哈希，正常路径直接误报。
#   现在的做法：把索引换成一次性临时文件，GIT_INDEX_FILE 指过去后
#   read-tree HEAD + add -A + write-tree。这样只反映「工作区内容」，与真实索引
#   状态无关（干净的还是脏的都一样），而且不会碰用户的索引与工作区。
worktree_snapshot() {
    local tmp
    tmp="$(mktemp -t limooo-deploy-index-XXXXXX)"
    rm -f "$tmp"
    # 以 HEAD 为基线，再把当前工作区（含未跟踪、不含被忽略）全部读进临时索引
    GIT_INDEX_FILE="$tmp" git read-tree HEAD 2>/dev/null || { rm -f "$tmp"; echo "unavailable"; return 0; }
    GIT_INDEX_FILE="$tmp" git add -A -- . >/dev/null 2>&1 || true
    GIT_INDEX_FILE="$tmp" git write-tree 2>/dev/null || echo "unavailable"
    rm -f "$tmp"
}

STAGED_TREE_BEFORE=""
if [ "$DO_COMMIT" = 1 ] && [ "$IN_GIT_TREE" = 1 ]; then
    show_cmd git add -A -- . ':!limooo.cn.png'
    git add -A -- . ':!limooo.cn.png'
    STAGED_TREE_BEFORE="$(worktree_snapshot)"
fi

# ── ⓪b 本地 CI 复刻（必须先于 commit / push / Pages / docs）────────────
# 历史教训：CI 是「先 build 再 typecheck / 测试」，而本地只跑过 vitest/pytest，
# 于是「本地全绿、push 完 30 秒收到失败通知」。这里把 CI 原样跑一遍。
#
# 检查对象必须与「要发出去的那棵树」一致（W3-3）：
#   --commit         → 已暂存内容（工作区未被忽略的改动已在 ⓪a 全部 stage）
#   --push（不提交） → 将要推送的 HEAD
#   --pages / --docs → 直接构建的工作树（pages_deploy.sh / docs_deploy.sh 都从工作树构建）
NEED_CHECKS=0
if [ "$DO_COMMIT" = 1 ] || [ "$DO_PUSH" = 1 ] || [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ]; then
    NEED_CHECKS=1
fi

# 脏树闸门（W3-3）：Pages / docs 直接构建工作树，工作树与任何 commit 不一致时
# 部署的就是「没被 CI 检查过、也没进 GitHub」的内容。不提交时先挡（省一次 CI），
# 提交时在 commit 之后再挡（那时 ⓪a 的 git add 已经被提交清掉）。
# 判定用与 ⓪a 相同的 pathspec，gitignore 的文件不算脏。
dirty_tree_gate() {
    local dirty_paths
    if [ "$IN_GIT_TREE" = 0 ]; then
        echo "Warning: not a git work tree; cannot verify that Pages matches a commit" >&2
        return 0
    fi
    dirty_paths="$(git status --porcelain -- . ':!limooo.cn.png')"
    if [ -z "$dirty_paths" ]; then
        return 0
    fi
    if [ "${LIMOOO_ALLOW_DIRTY:-0}" = 1 ]; then
        echo "Warning: deploying a dirty working tree (LIMOOO_ALLOW_DIRTY=1)"
        return 0
    fi
    echo "FATAL: working tree has uncommitted changes; Pages/docs build the working tree" >&2
    printf '%s\n' "$dirty_paths" | sed 's/^/       /' >&2
    echo "       commit them first, or set LIMOOO_ALLOW_DIRTY=1 to deploy them on purpose" >&2
    exit 1
}

if [ "$DO_COMMIT" = 0 ] && { [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ]; }; then
    dirty_tree_gate
fi

if [ "$NEED_CHECKS" = 1 ]; then
    if [ "${LIMOOO_SKIP_CHECKS:-0}" = 1 ]; then
        echo "Check: skipped (LIMOOO_SKIP_CHECKS=1)"
    elif [ "$DO_COMMIT" = 1 ]; then
        run_step "Check" bash ops/ci_check.sh
    elif [ "$DO_PUSH" = 1 ]; then
        run_step "Check" bash ops/ci_check.sh --ref=HEAD
    else
        run_step "Check" bash ops/ci_check.sh
    fi
fi

# ── ⓪c 检查期间工作区是否又被改动 ──────────────────────────────────
# 检查前后各取一次工作区快照，不一致说明检查期间有别的工具动了文件：此时提交的
# 内容不等于检查过的内容，直接退出让用户重跑（宁可多跑一次，也不提交未检查的树）。
# 快照取不到（如 read-tree 失败）时两边都会是 "unavailable"，不在这里挡路。
if [ "$DO_COMMIT" = 1 ] && [ "$IN_GIT_TREE" = 1 ]; then
    worktree_snapshot_after="$(worktree_snapshot)"
    if [ "$worktree_snapshot_after" != "$STAGED_TREE_BEFORE" ]; then
        echo "FATAL: working tree changed during checks; rerun deploy" >&2
        echo "       snapshot before checks $STAGED_TREE_BEFORE" >&2
        echo "       snapshot after checks  $worktree_snapshot_after" >&2
        exit 1
    fi
fi

# ── ① git commit ────────────────────────────────────────────────────
if [ "$DO_COMMIT" = 1 ]; then
    if [ "$IN_GIT_TREE" = 0 ]; then
        echo "Warning: not a git work tree, skipped commit" >&2
    else
        if git diff --cached --quiet; then
            echo "Git: nothing to commit"
        else
            # 文件名与状态要先取：短 SHA 只有提交后才知道，所以先 commit，再打印这一块
            staged_status="$(git diff --cached --name-status)"
            staged_total=0
            [ -n "$staged_status" ] && staged_total="$(printf '%s\n' "$staged_status" | wc -l | tr -d ' ')"
            # 提交信息：有 -m/--message 就 "deploy: <msg>"，否则沿用带时间戳的自动信息
            if [ -n "$COMMIT_MESSAGE" ]; then
                commit_subject="deploy: $COMMIT_MESSAGE"
            else
                commit_subject="deploy: auto-commit $(date '+%Y-%m-%d %H:%M')"
            fi
            show_cmd git commit -m "$commit_subject"
            git commit -m "$commit_subject" >/dev/null
            # 版本号 = 本次新提交的短 SHA
            echo "Git: committed $(git rev-parse --short HEAD)"
            # 状态字母取自 git --name-status（A 新增 / D 删除 / M 修改 / R 重命名...）占第 4 列，
            # 第 5 列空一格，文件名仍与上一行 "committed" 的首字符对齐（第 6 列）。
            staged_shown=0
            while IFS="$(printf '\t')" read -r st path_old path_new; do
                [ -z "$st" ] && continue
                [ "$staged_shown" -ge "$GIT_FILE_LIST_LIMIT" ] && break
                status_letter="${st:0:1}"
                # git 对重命名/复制给出 "R100\told\tnew"，展示新路径
                [ -n "$path_new" ] && path_old="$path_new"
                echo "   ${status_letter} ${path_old}"
                staged_shown=$((staged_shown + 1))
            done <<< "$staged_status"
            if [ "$staged_total" -gt "$staged_shown" ]; then
                echo "     ... and $((staged_total - staged_shown)) more"
            fi
        fi
        # 刚提交的这棵树就是 ⓪ 里检查过的内容，pre-push hook 不必再跑一遍。
        export LIMOOO_CI_CHECKED_SHA="$(git rev-parse HEAD)"
    fi
fi

# ── ② git push ──────────────────────────────────────────────────────
PUSH_FAILED=0
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
                echo "Git: pushed to GitHub"
            elif [ "${LIMOOO_ALLOW_PUSH_FAIL:-0}" = 1 ]; then
                # 应急放行：线上会领先 GitHub。收尾必须明确提示，不能静默继续。
                PUSH_FAILED=1
            else
                echo "FATAL: git push failed; aborting before Pages deploy" >&2
                echo "       fix the remote/credentials and rerun, or set LIMOOO_ALLOW_PUSH_FAIL=1 to deploy anyway" >&2
                exit 1
            fi
        else
            # 分叉必须人工处理：自动 rebase/merge 会把别人的提交卷进这次部署
            echo "FATAL: local and GitHub histories diverged, resolve manually (rebase/merge) first" >&2
            exit 1
        fi
    fi
fi

# ── ②b 脏树闸门（提交之后再验一次）──────────────────────────────────
# --commit 时 ⓪a 的 git add 会把未提交改动全部提交掉，所以这里要在 commit 之后
# 才能判断「提交完还剩没剩脏东西」；--pages / --docs 单独跑时已在 ⓪b 之前挡过。
if [ "$DO_COMMIT" = 1 ] && { [ "$DO_PAGES" = 1 ] || [ "$DO_DOCS" = 1 ]; }; then
    dirty_tree_gate
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

# 应急放行的提示必须是**最后一行**：这是唯一能让「线上领先 GitHub」这件事
# 出现在部署日志末尾的方式，翻日志时不会被后面的步骤冲掉。
if [ "$PUSH_FAILED" = 1 ]; then
    echo "Warning: deployed without pushing to GitHub"
fi

echo "Deploy: done"
