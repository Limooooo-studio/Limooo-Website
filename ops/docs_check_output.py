#!/usr/bin/env python3
"""校验 docs.limooo.cn 的构建产物：每个 md 都产出了对应 HTML。

源文件放在语言目录里（en-us/video-platform.md），URL 由 .vitepress/rewrites.json
改成「语言码在最后一段」（/video-platform/en-us）。这个脚本和 VitePress 配置读取
同一份 rewrites.json，保证「加一个 md 就会有一个页面」这条约定不会被漏掉。

<docs-dir> 传的是 **VitePress 内容根**，也就是 site/docs/docs/
（site/docs/ 是按子域分的容器：docs/ 归 docs.limooo.cn，services/ 归
services.limooo.cn），.vitepress/ 与它同级。

用法：
    python3 ops/docs_check_output.py <docs-dir> <dist-dir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: docs_check_output.py <docs-dir> <dist-dir>", file=sys.stderr)
        return 2
    docs = Path(sys.argv[1])
    dist = Path(sys.argv[2])
    if not docs.is_dir() or not dist.is_dir():
        print("FATAL: docs-dir or dist-dir not found", file=sys.stderr)
        return 1

    rewrites_path = docs / ".vitepress" / "rewrites.json"
    rewrites: dict[str, str] = {}
    if rewrites_path.is_file():
        rewrites = json.loads(rewrites_path.read_text(encoding="utf-8"))

    missing: list[tuple[str, str]] = []
    routes: list[tuple[str, str]] = []
    for md in sorted(docs.rglob("*.md")):
        rel = md.relative_to(docs).as_posix()
        if rel.startswith(".vitepress/") or rel.startswith("node_modules/"):
            continue
        route = rewrites.get(rel, rel)
        if route.endswith(".md"):
            route = route[: -len(".md")]
        html = dist / f"{route}.html"
        routes.append((rel, "/" + route))
        if not html.is_file():
            missing.append((rel, "/" + route))

    for rel, route in routes:
        print(f"  {rel:<32} -> {route}")
    print(f"[docs-check] {len(routes)} markdown file(s), {len(missing)} missing")

    if missing:
        for rel, route in missing:
            print(f"FATAL: {rel} produced no {route}.html", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
