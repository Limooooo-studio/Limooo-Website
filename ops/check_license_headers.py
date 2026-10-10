#!/usr/bin/env python3

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

"""许可证头闸门：第一方源码必须带 AGPL 头（前 25 行内出现 GNU Affero / AGPL）。

为什么需要它：AGPL 头是**逐文件**的约定，此前仓库里只有「数一遍缺几个」的临时
命令，没有闸门。于是 `ops/*.sh` 那 8 个脚本被整批漏掉且无人察觉，直到下一轮审计
手工数了一遍才发现——计数取证不是防线，闸门才是。

判定与排除规则都写在下面的常量里（输出全英文、代码注释中文，与 ops/ 其他脚本一致）。
用法、检查范围与退出码见 USAGE（`--help` 打印同一份文本）。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 只看开头这一小段：头文本会换行断开，扫太窄会漏；扫全文又会把正文里出现的
# AGPL 字样（例如某个脚本自己的一句话说明）误判成头。
SCAN_LINES = 25
HEADER_MARKER = re.compile(r"GNU Affero|AGPL")

# 必须带头的第一方源码：(目录, 扩展名, 是否递归)。
#
# 这里**不拼 pathspec**，而是「列出 git 里全部文件，再按目录 + 扩展名过滤」：
# git 的 `dir/**/*.ts` 并不匹配 dir 下的顶层文件（实测 functions/*.ts = 65 个、
# functions/**/*.ts = 58 个，两批不重叠），只写 `**/` 那一版会把顶层整批漏掉——
# 上一批「数了 64 个」却仍以为覆盖完整，正是踩在这个坑上。过滤式选择没有这个洞。
RULES: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    ("functions", (".ts",), True),
    ("ops", (".ts", ".js", ".py", ".sh"), True),
    ("src", (".py",), False),
    ("tests", (".py",), False),
)

# ── 范围说明：为什么只有这几个目录，以及为什么**故意不查** js 资产 ──────────
#
# 纳入判据是「**随仓库走、且属源码性质**」：functions/**/*.ts（含 *.test.ts 与
# types.d.ts）、ops/**/*.{ts,js,py,sh}、src/*.py、tests/*.py —— 它们要么定义运行时
# 行为，要么定义闸门本身，改一行都要评审，头文本不会进访客的字节流。
#
# src/static/js/*.js（12 个，合计 92,996 B）**故意排除**，不是漏了（2026-10-11 拍板）：
#   - 它们是**发布给浏览器的资产**：src/build.py 用 shutil.copytree 把 src/static/
#     原样复制进 public/，对这些文件**不做压缩、不去注释**，再由 Pages 直接下发；
#   - 加 17 行 AGPL 头 ≈ +9.6 KB ≈ 未压缩体积 **+10%**，且这笔字节由**每一个访客**支付
#     （还要算上它在 CDN 与浏览器里的传输/解析成本）；
#   - 为注释元数据让全站访客多下 10% 的 JS 不划算。它们的许可归属由仓库根
#     LICENSE.md / LICENSE_zh_CN.md（及 docs 站四语副本）覆盖，不靠逐文件头。
#   - 将来若给它们加上压缩/去注释步骤（届时头不会进浏览器），可重新评估纳入。
#
# tests/helpers/*.ts 同样排除：测试辅助代码，不与 tests/*.py 一起判（判据是否统一留待后续再议）。
# 这两条写成注释而不是 --help 正文：后人在代码里问「为什么这里不查 js 资产」时应直接读到答案，
# 而不是以为检查器漏了一整类文件。

# 显式不带头（第三方 / 生成物 / 非源码）。这些路径本来就不落在 RULES 里，
# 这一层是保险丝：将来 RULES 被放宽时它们不会被误报，也不会被「顺手补头」
# ——给第三方许可证文本加自己的头属于许可污染。
NOT_REQUIRED = re.compile(
    r"^(?:"
    r"src/static/fonts/.+\.txt$"  # 第三方字体许可证（OFL.txt / LICENSE.txt）
    r"|ops/fonts/.+\.txt$"
    r"|(?:.*/)?LICENSE[^/]*\.md$"  # 项目自己的许可证正文
    r"|ops/migrations/.+\.sql$"
    r"|locales/.+\.json$"
    r"|.+\.(?:csv|toml|json)$"
    r"|ops/email-templates/.+\.html$"
    r"|docs/.*$"
    r")"
)

USAGE = """License header gate: every first-party source file must carry the AGPL header.

Checked (the header must appear in the first 25 lines, as 'GNU Affero' or 'AGPL'):
  functions/**/*.ts
  ops/**/*.ts, ops/**/*.js, ops/**/*.py, ops/**/*.sh
  src/*.py
  tests/*.py

Never checked (third-party or generated; adding a header there would be wrong):
  src/static/fonts/**.txt, ops/fonts/**.txt   (third-party OFL.txt / LICENSE.txt)
  LICENSE*.md, ops/migrations/*.sql, locales/*.json
  *.csv, *.toml, *.json, ops/email-templates/*.html, docs/**

Tracked files and untracked-but-not-ignored files are both checked, so a new file is
caught before its first commit instead of by CI after the push.

Usage:
  python3 ops/check_license_headers.py           # verify; exit 1 when a header is missing
  python3 ops/check_license_headers.py --list    # print the checked set, grouped by rule
  python3 ops/check_license_headers.py --help

Exit code 0 = every checked file carries the header."""


def git_paths() -> list[str]:
    """git 已跟踪 + 未跟踪未被忽略的文件；git 不可用时 FATAL，绝不静默跳过闸门。"""
    try:
        completed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"FATAL: cannot list repository files with git ({exc})", file=sys.stderr)
        raise SystemExit(2) from exc
    return sorted(name for name in completed.stdout.decode("utf-8", "replace").split("\0") if name)


def rule_of(path: str) -> str | None:
    """命中的规则目录（用于分组）；不在检查范围内的文件返回 None。"""
    if NOT_REQUIRED.match(path):
        return None
    for directory, suffixes, recursive in RULES:
        prefix = f"{directory}/"
        if not path.startswith(prefix):
            continue
        rest = path[len(prefix) :]
        if not recursive and "/" in rest:
            continue
        if rest.endswith(suffixes):
            return directory
    return None


def read_head(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return [handle.readline() for _ in range(SCAN_LINES)]


def hint_for(path: str) -> str:
    if path.endswith((".sh", ".py")):
        return "insert it after the shebang on line 1"
    return "insert it as the file header comment"


def check(names: list[str]) -> tuple[list[str], list[str]]:
    """返回（缺头清单, shebang 不在第 1 行的 .sh 清单）。"""
    missing: list[str] = []
    bad_shebang: list[str] = []
    for name in names:
        head = read_head(ROOT / name)
        # 头必须插在 shebang **之后**：注释掉 shebang 的脚本仍然能 `bash -n` 通过，
        # 却已经不能直接执行，所以这一条单独判、单独报。
        if name.endswith(".sh") and not (head and head[0].startswith("#!")):
            bad_shebang.append(name)
        if not HEADER_MARKER.search("".join(head)):
            missing.append(name)
    return missing, bad_shebang


def report(missing: list[str], bad_shebang: list[str]) -> int:
    print("FATAL: license header check failed", file=sys.stderr)
    if missing:
        width = max(len(name) for name in missing)
        print(f"  missing the AGPL header in the first {SCAN_LINES} lines:", file=sys.stderr)
        for name in missing:
            print(f"    {name:<{width}}  {hint_for(name)}", file=sys.stderr)
    if bad_shebang:
        width = max(len(name) for name in bad_shebang)
        print("  the shebang must stay on line 1 (the header goes after it):", file=sys.stderr)
        for name in bad_shebang:
            print(f"    {name:<{width}}  restore '#!/usr/bin/env bash' as the first line", file=sys.stderr)
    print("  header text reference: ops/ci_check.sh lines 3-18", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    args = argv[1:]
    for arg in args:
        if arg in ("--help", "-h"):
            print(USAGE)
            return 0
        if arg != "--list":
            print(f"FATAL: unknown argument {arg}", file=sys.stderr)
            print("       supported: --list / --help", file=sys.stderr)
            return 2

    checked: dict[str, list[str]] = {directory: [] for directory, _, _ in RULES}
    for name in git_paths():
        directory = rule_of(name)
        if directory is not None:
            checked[directory].append(name)
    total = sum(len(names) for names in checked.values())

    if "--list" in args:
        print(f"license headers: {total} files in scope")
        for directory, _, _ in RULES:
            names = checked[directory]
            print(f"  {directory:<12}{len(names):>4}")
            for name in names:
                print(f"    {name}")
        return 0

    names = [name for directory, _, _ in RULES for name in checked[directory]]
    try:
        missing, bad_shebang = check(names)
    except OSError as exc:
        print(f"FATAL: cannot read a source file ({exc})", file=sys.stderr)
        return 2

    if missing or bad_shebang:
        return report(missing, bad_shebang)
    print(f"license headers: OK ({total} files checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
