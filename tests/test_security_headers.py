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

"""安全响应头一致性测试。

`ops/check_security_headers.py` 是安全头的守卫脚本，但历史上只在人工/部署时
运行过，所以 ops/security-headers.json 与 functions/_lib/security.ts 之间的
CSP 漂移（connect-src 漏放行 challenges.cloudflare.com）长期没被发现，
直接导致门禁页 Turnstile 永远拿不到 token —— 用户侧表现为"无限人机验证"。

把守卫接进 pytest，让这类漂移在提交前就失败，而不是等用户反馈。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ops"))

import check_security_headers as guard  # noqa: E402

TURNSTILE = "https://challenges.cloudflare.com"


def _csp_from_json() -> str:
    return json.loads(
        (ROOT / "ops" / "security-headers.json").read_text(encoding="utf-8")
    )["Content-Security-Policy"]


def _origins(csp: str, section: str) -> set[str]:
    match = re.search(rf"{section} ([^;]+)", csp)
    if not match:
        return set()
    return {
        token
        for token in match.group(1).split()
        if token.startswith(("http://", "https://"))
    }


def test_security_headers_guard_passes():
    """真实仓库状态下守卫必须通过（两侧 CSP 完全一致且第三方来源自洽）。"""
    assert guard.main() == 0


def test_turnstile_origin_allowed_for_script_frame_and_connect():
    """Turnstile 需要 script-src/frame-src/connect-src 三条指令同时放行。

    少任何一条，widget 都会"能显示但永远拿不到 token"，即无限人机验证。
    """
    csp = _csp_from_json()
    for section in ("script-src", "frame-src", "connect-src"):
        assert TURNSTILE in _origins(csp, section), (
            f"CSP {section} 缺少 {TURNSTILE}，Turnstile 将无法完成验证"
        )


def test_guard_rejects_connect_src_missing_third_party_origin(tmp_path, monkeypatch, capsys):
    """回归守卫：删掉 connect-src 里的 Turnstile 来源后，守卫必须报错。

    这条锁住"无限人机验证"的根因，防止有人再次把 connect-src 收紧。
    """
    original = (ROOT / "ops" / "security-headers.json").read_text(encoding="utf-8")
    # 只从 connect-src 里摘掉 Turnstile（script-src 那份要留着，才能验证守卫
    # 是靠 connect-src 判定失败的）。
    broken = original.replace(
        f" {TURNSTILE} http://cloudflareinsights.com", " http://cloudflareinsights.com"
    )
    assert broken != original, "测试前提失效：JSON 中未找到预期的 connect-src 片段"

    broken_path = tmp_path / "security-headers.json"
    broken_path.write_text(broken, encoding="utf-8")
    monkeypatch.setattr(guard, "JSON_PATH", broken_path)

    assert guard.main() == 1
    assert "connect-src" in capsys.readouterr().err


def test_cloudflare_insights_origins_allowed():
    """Cloudflare Web Analytics：脚本走 static.cloudflareinsights.com，RUM 回传走
    cloudflareinsights.com，两处都需要放行 http/https（同源部署有走 http 的场景）。
    """
    csp = _csp_from_json()
    for section in ("script-src",):
        origins = _origins(csp, section)
        for origin in (
            "http://static.cloudflareinsights.com",
            "https://static.cloudflareinsights.com",
        ):
            assert origin in origins, f"CSP {section} 缺少 {origin}"
    connect_origins = _origins(csp, "connect-src")
    for origin in ("http://cloudflareinsights.com", "https://cloudflareinsights.com"):
        assert origin in connect_origins, f"CSP connect-src 缺少 {origin}"


def test_guard_rejects_insight_script_without_connect_pair(tmp_path, monkeypatch, capsys):
    """beacon 的例外是有条件的：connect-src 丢掉 cloudflareinsights.com 后，
    script-src 里的 static.cloudflareinsights.com 必须被守卫拦下。
    """
    original = (ROOT / "ops" / "security-headers.json").read_text(encoding="utf-8")
    broken = original.replace(
        " http://cloudflareinsights.com https://cloudflareinsights.com", ""
    )
    assert broken != original, "测试前提失效：JSON 中未找到 insight 的 connect-src 片段"

    broken_path = tmp_path / "security-headers.json"
    broken_path.write_text(broken, encoding="utf-8")
    monkeypatch.setattr(guard, "JSON_PATH", broken_path)

    assert guard.main() == 1
    assert "static.cloudflareinsights.com" in capsys.readouterr().err


def test_docs_csp_allows_cloudflare_insights():
    """docs.limooo.cn 的 CSP 由 ops/docs_headers.py 生成，同样要放行 beacon。"""
    import docs_headers

    header = docs_headers.csp([], [])
    script_src = _origins(header, "script-src")
    connect_src = _origins(header, "connect-src")
    for origin in (
        "http://static.cloudflareinsights.com",
        "https://static.cloudflareinsights.com",
    ):
        assert origin in script_src, f"docs CSP script-src 缺少 {origin}"
    for origin in ("http://cloudflareinsights.com", "https://cloudflareinsights.com"):
        assert origin in connect_src, f"docs CSP connect-src 缺少 {origin}"
