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

"""校验 ops/security-headers.json 与 Pages 侧 functions/_lib/security.ts 一致。

只依赖标准库。05 的安全头 JSON 是唯一文案源，本脚本用于防止两侧镜像漂移。
运行：
    python3 ops/check_security_headers.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "ops" / "security-headers.json"
TS_PATH = ROOT / "functions" / "_lib" / "security.ts"


def main() -> int:
    expected = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    if not isinstance(expected, dict):
        print("FATAL: security-headers.json must be a JSON object", file=sys.stderr)
        return 1

    ts = TS_PATH.read_text(encoding="utf-8")
    errors: list[str] = []
    for name, value in expected.items():
        pattern = re.compile(
            rf'"{re.escape(name)}"\s*:\s*"((?:\\.|[^"\\])*)"',
        )
        match = pattern.search(ts)
        if not match:
            errors.append(f"security.ts is missing field {name}")
            continue
        actual = json.loads(f'"{match.group(1)}"')
        if actual != value:
            errors.append(f"security.ts {name}: JSON={value!r} actual={actual!r}")
        if name == "Content-Security-Policy":
            if "'unsafe-inline'" in actual:
                errors.append("CSP still contains 'unsafe-inline', which docs/14 forbids")
            script_src = re.search(r"script-src ([^;]+)", actual)
            style_src = re.search(r"style-src ([^;]+)", actual)
            for section, match in (("script-src", script_src), ("style-src", style_src)):
                if match and "https://limooo.cn" in match.group(1):
                    errors.append(f"CSP {section} still allows https://limooo.cn, use 'self' instead")

            # 第三方组件一致性守卫。
            #
            # Turnstile 完成一次求解需要三条指令同时放行同一来源：
            #   script-src  加载 api.js
            #   frame-src   内嵌 challenge iframe
            #   connect-src 提交求解结果、取回 token
            # 只放行前两条会得到一个"能显示、点不动、永远拿不到 token"的
            # widget —— 表现为无限人机验证。历史上正是 connect-src 漏了
            # challenges.cloudflare.com，导致门禁永远无法通过。
            def origins(header: str, section: str) -> set[str]:
                match = re.search(rf"{section} ([^;]+)", header)
                if not match:
                    return set()
                return {
                    token
                    for token in match.group(1).split()
                    if token.startswith(("http://", "https://"))
                }

            connect_origins = origins(actual, "connect-src")

            # 少数第三方组件的"拉脚本"与"回传数据"本来就落在不同主机上，
            # 不能按"script-src 的来源必须在 connect-src"一刀切。已登记的例外：
            # Cloudflare Web Analytics 的 beacon —— 脚本来自
            # static.cloudflareinsights.com（script-src），RUM 数据回传到
            # cloudflareinsights.com（connect-src）。
            script_connect_pairs = {
                "static.cloudflareinsights.com": "cloudflareinsights.com",
            }
            connect_hosts = {o.split("://", 1)[-1] for o in connect_origins}

            for section in ("script-src", "frame-src"):
                for origin in origins(actual, section):
                    if origin in connect_origins:
                        continue
                    paired = script_connect_pairs.get(origin.split("://", 1)[-1])
                    if paired and paired in connect_hosts:
                        continue
                    errors.append(
                        f"CSP {section} allows {origin} but connect-src lacks it: "
                        f"the third-party component will hang forever because CSP blocks "
                        f"its requests (Turnstile shows an endless challenge); "
                        f"add {origin} to connect-src"
                    )

    if errors:
        print("FATAL: security headers validation failed", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("security headers: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
