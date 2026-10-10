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

"""ops/check_ip_rays.py 的纯函数测试（IP 归一化 / hash 识别 / 渲染）。"""

import ast
import re
from pathlib import Path

import pytest

import ops.check_ip_rays as cir

HAN = re.compile(r"[\u4e00-\u9fff]")


def test_terminal_output_is_english():
    """命令行输出必须全英文（AGENTS.md「命令行脚本的输出一律全英文」）。

    只允许注释与 docstring 用中文；任何 print/help/报错文本出现中文即失败。
    用 AST 取出真正的字符串字面量，避免把注释和 docstring 误判成输出文本。
    """
    tree = ast.parse(Path(cir.__file__).read_text(encoding="utf-8"))

    # docstring（模块/函数/类）不面向终端，豁免。
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc is not None:
                docstrings.add(doc)

    offenders = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value not in docstrings
        and HAN.search(node.value)
    ]
    assert not offenders, "terminal-facing text must be English:\n" + "\n".join(offenders)


def test_default_limit_is_five():
    """默认返回 5 条（用户 2026-09-27 指定）。"""
    assert cir.DEFAULT_LIMIT == 5


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("176.122.161.108", "176.122.161.108"),
        (" 176.122.161.108 ", "176.122.161.108"),
        ("[240e:404::1]", "240e:404::1"),
        ("240e:404:9210:1d78:7c62:faff:fef9:34b5", "240e:404:9210:1d78:7c62:faff:fef9:34b5"),
        # 日志里常见 host:port 形式
        ("1.2.3.4:52344", "1.2.3.4"),
    ],
)
def test_normalize_ip_accepts_valid(raw, expected):
    assert cir.normalize_ip(raw) == expected


@pytest.mark.parametrize("raw", ["", "notanip", "999.1.1.1", "1.2.3.4.5"])
def test_normalize_ip_rejects_invalid(raw):
    with pytest.raises(ValueError):
        cir.normalize_ip(raw)


def test_looks_like_hash():
    assert cir.looks_like_hash("d51153cb767fc758")
    assert cir.looks_like_hash("D51153CB767FC758")
    assert not cir.looks_like_hash("d51153cb767fc75")  # 15 位
    assert not cir.looks_like_hash("d51153cb767fc758a")  # 17 位
    assert not cir.looks_like_hash("z1153cb767fc758")  # 非 hex


def test_render_v2_renders_fields():
    line = cir.render_v2(
        {
            "ray": "a4162d53fc471732-SJC",
            "ts": 1790466693,
            "host": "visitor.limooo.cn",
            "path": "/",
            "method": "GET",
            "status": 200,
            "country": "US",
            "duration_ms": 386,
        }
    )
    assert "a4162d53fc471732-SJC" in line
    assert "visitor.limooo.cn/" in line
    assert "386ms" in line
    # 无装饰符号（AGENTS.md：终端输出只要纯净英文）。
    assert "==" not in line and "--" not in line


def test_render_v2_columns_align():
    """定宽对齐：状态列右对齐、ray 列左对齐，长度不同的行也落在同一列。"""
    base = {"ts": 1790466693, "method": "GET", "country": "US", "path": "/"}
    short = cir.render_v2({**base, "ray": "a4162d53fc471732-SJC", "status": 200, "duration_ms": 5})
    long = cir.render_v2({**base, "ray": "a4158dde3e649f60-AMS", "status": 301, "duration_ms": 1234})
    assert short.index("200") == long.index("301")
    assert short.index("GET") == long.index("GET")


def test_render_legacy_marks_source_and_fills_gap():
    line = cir.render_legacy({"ray": "a40468eaedd2a158", "ts": 1790280389, "host": "x", "ip": "1.2.3.4"})
    assert "a40468eaedd2a158" in line
    assert line.endswith("[legacy]")
    # 旧表没有 duration，用 - 占位，不留空洞。
    assert " - " in line


def test_no_decorative_banner_in_source():
    """源码里不应再出现 == xxx == 这种装饰性横幅（AGENTS.md 约定）。"""
    source = Path(cir.__file__).read_text(encoding="utf-8")
    assert "print(f\"== " not in source
    assert 'print("==' not in source


def test_resolve_hashes_requires_key(monkeypatch):
    """密钥缺失时必须给出警告，而不是静默返回「无记录」。"""
    hashes, warn = cir.resolve_hashes({"token": "t"}, {}, "1.2.3.4")
    assert hashes == []
    assert "VISITOR_IP_KEY" in warn


def test_resolve_hashes_roundtrip(monkeypatch):
    """加密行能被解回 IP，并映射到同一行的 ip_hash。"""
    if cir.Fernet is None:  # pragma: no cover - 取决于解释器
        pytest.skip("cryptography not installed")

    from cryptography.fernet import Fernet

    key = Fernet.generate_key().decode()
    token = Fernet(key.encode()).encrypt(b"176.122.161.108").decode()
    other = Fernet(key.encode()).encrypt(b"8.8.8.8").decode()

    monkeypatch.setattr(
        cir,
        "d1_query_retry",
        lambda cfg, sql, tries=4: [
            {"ip_hash": "d51153cb767fc758", "ip_enc": token},
            {"ip_hash": "aaaaaaaaaaaaaaaa", "ip_enc": other},
            {"ip_hash": "bbbbbbbbbbbbbbbb", "ip_enc": "not-a-valid-token"},
            {"ip_hash": "cccccccccccccccc", "ip_enc": ""},
        ],
    )

    hashes, warn = cir.resolve_hashes({}, {"VISITOR_IP_KEY": key}, "176.122.161.108")
    assert hashes == ["d51153cb767fc758"]
    assert warn is None
