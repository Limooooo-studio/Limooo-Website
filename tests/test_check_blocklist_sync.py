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

"""ops/check_blocklist_sync.py 的纯函数与端到端测试（全部离线，不碰 D1/CF）。

这些用例守的是三件事：
    1. 归一化必须与 ops/sync-worker 的 normalizeListItem 一致（否则脚本会把
       「/32 与裸 IP」误报成漂移，运维就会去追一个不存在的故障）；
    2. 差异判定与退出码（0 一致 / 1 漂移 / 2 查不动）不能混；
    3. 终端输出全英文、无装饰符号（AGENTS.md 约定）。
"""

import ast
import json
import re
from pathlib import Path

import pytest

import ops.check_blocklist_sync as cbs

HAN = re.compile(r"[\u4e00-\u9fff]")


def test_terminal_output_is_english():
    """只允许注释与 docstring 用中文；任何面向终端的字符串出现中文即失败。"""
    tree = ast.parse(Path(cbs.__file__).read_text(encoding="utf-8"))

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


def test_no_decorative_banner_in_source():
    source = Path(cbs.__file__).read_text(encoding="utf-8")
    assert 'print("==' not in source
    assert 'print(f"==' not in source


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1.2.3.4/32", "1.2.3.4"),
        ("2001:db8::1/128", "2001:db8::1"),
        ("1.2.3.0/24", "1.2.3.0/24"),
        ("2001:db8::/64", "2001:db8::/64"),
        ("1.2.3.4", "1.2.3.4"),
        ("  1.2.3.4/32  ", "1.2.3.4"),
        # IPv4 不该被 /128 规则吃掉，反之亦然
        ("1.2.3.4/128", "1.2.3.4/128"),
        ("2001:db8::1/32", "2001:db8::1/32"),
        ("", ""),
    ],
)
def test_normalize_matches_worker(raw, expected):
    """与 ops/sync-worker/src/index.ts 的 normalizeListItem 同一张表。"""
    assert cbs.normalize_list_item(raw) == expected


def test_identical_sets_have_no_diff():
    to_add, to_remove = cbs.compute_diff(
        ["1.2.3.0/24"], {"1.2.3.0/24": "i1"}
    )
    assert (to_add, to_remove) == ([], [])


def test_slash32_and_bare_ip_are_not_drift():
    """D1 存 /32、CF 存裸 IP —— 这是同一个条目，不能报成漂移。"""
    to_add, to_remove = cbs.compute_diff(["1.2.3.4/32"], {"1.2.3.4": "i1"})
    assert (to_add, to_remove) == ([], [])


def test_drift_is_reported_on_both_sides():
    to_add, to_remove = cbs.compute_diff(
        ["1.2.3.0/24", "9.9.9.0/24"],
        {"1.2.3.0/24": "i1", "4.4.4.0/24": "i2"},
    )
    assert to_add == ["9.9.9.0/24"]
    assert to_remove == ["4.4.4.0/24"]


def test_to_add_keeps_the_d1_spelling():
    """to_add 报 D1 侧原始写法（Worker 推上去的就是它），不是归一化后的值。"""
    to_add, _ = cbs.compute_diff(["1.2.3.4/32"], {})
    assert to_add == ["1.2.3.4/32"]


def test_compute_diff_is_order_independent():
    a = cbs.compute_diff(["b/24", "a/24"], {})
    b = cbs.compute_diff(["a/24", "b/24"], {})
    assert a == b == (["a/24", "b/24"], [])


# --- 端到端（stub 掉 D1 与 Cloudflare，main() 之外的代码全真跑） ---------------

CFG = {"token": "t", "account_id": "acct", "database_id": "db"}


def _stub(monkeypatch, *, d1_rows, list_items, runs=None, d1_fails=False):
    """把 d1_query_retry / cf_get_json 换成内存实现。"""
    calls: dict[str, list] = {"d1": [], "cf": [], "writes": []}
    rows = list(d1_rows)

    def fake_d1_query_retry(cfg, sql, tries=4, raise_on_failure=False):
        calls["d1"].append(sql)
        if d1_fails:
            return None
        if "FROM blocked_ips" in sql:
            return [{"cidr": cidr} for cidr in rows]
        if "FROM worker_runs" in sql:
            job = sql.split("job = '", 1)[1].split("'", 1)[0]
            return [runs[job]] if runs and runs.get(job) else []
        raise AssertionError(f"unexpected SQL: {sql}")

    def fake_d1_query(cfg, sql):
        calls["writes"].append(sql)
        return []

    def fake_cf_get_json(token, url, attempts=4):
        calls["cf"].append(url)
        if "/rules/lists?" in url:
            return {"result": [{"name": cbs.LIST_NAME, "id": "list-1", "modified_on": "2026-10-11T00:00:00Z"}]}
        if "/items" in url:
            return {
                "result": [{"ip": ip, "id": f"id-{ip}"} for ip in list_items],
                "result_info": {},
            }
        raise AssertionError(f"unexpected URL: {url}")

    monkeypatch.setattr(cbs.d1_client, "d1_query_retry", fake_d1_query_retry)
    monkeypatch.setattr(cbs.d1_client, "d1_query", fake_d1_query)
    monkeypatch.setattr(cbs, "cf_get_json", fake_cf_get_json)
    monkeypatch.setattr(cbs.d1_client, "load_env", lambda *a, **k: {})
    monkeypatch.setattr(cbs.d1_client, "cloudflare_config", lambda env: dict(CFG))
    monkeypatch.setattr(cbs, "install_ca_bundle", lambda: None)
    return calls


def _run(monkeypatch, argv, **kwargs):
    monkeypatch.setattr("sys.argv", ["check_blocklist_sync.py", *argv])
    return _stub(monkeypatch, **kwargs), cbs.main()


def test_main_reports_ok_and_exits_zero(monkeypatch, capsys):
    _, code = _run(
        monkeypatch,
        [],
        d1_rows=["1.2.3.0/24"],
        list_items=["1.2.3.0/24"],
        runs={
            "blocklist_sync": {
                "job": "blocklist_sync",
                "started_at": 1791000000,
                "finished_at": 1791000001,
                "outcome": "ok",
                "added": 1,
                "removed": 0,
                "error": None,
            }
        },
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "desired=1 actual=1 to_add=0 to_remove=0" in out
    assert "result: OK" in out
    assert "outcome=ok" in out


def test_main_exits_one_on_drift(monkeypatch, capsys):
    _, code = _run(
        monkeypatch,
        [],
        d1_rows=["1.2.3.0/24", "9.9.9.0/24"],
        list_items=["1.2.3.0/24"],
    )
    out = capsys.readouterr().out
    assert code == 1
    assert "desired=2 actual=1 to_add=1 to_remove=0" in out
    assert "+ 9.9.9.0/24" in out
    assert "result: DRIFT" in out


def test_main_exits_one_when_the_last_run_failed(monkeypatch, capsys):
    _, code = _run(
        monkeypatch,
        [],
        d1_rows=["1.2.3.0/24"],
        list_items=["1.2.3.0/24"],
        runs={
            "blocklist_sync": {
                "job": "blocklist_sync",
                "started_at": 1791000000,
                "finished_at": 1791000001,
                "outcome": "failed",
                "added": None,
                "removed": None,
                "error": "CF API 403 https://api.cloudflare.com/...",
            }
        },
    )
    out = capsys.readouterr().out
    assert code == 1
    assert "outcome=failed" in out
    assert "CF API 403" in out
    assert "result: FAILED RUN" in out


def test_main_exits_two_when_the_check_cannot_complete(monkeypatch, capsys):
    _, code = _run(monkeypatch, [], d1_rows=["1.2.3.0/24"], list_items=[], d1_fails=True)
    out = capsys.readouterr().out
    assert code == 2
    assert "status=error" in out
    assert "NOT a statement about drift" in out


def test_main_json_shape(monkeypatch, capsys):
    _, code = _run(
        monkeypatch,
        ["--json"],
        d1_rows=["1.2.3.0/24", "9.9.9.0/24"],
        list_items=["1.2.3.0/24", "4.4.4.0/24"],
        runs={
            "blocklist_sync": {
                "job": "blocklist_sync",
                "started_at": 1791000000,
                "finished_at": 1791000001,
                "outcome": "ok",
                "added": 0,
                "removed": 0,
                "error": None,
            }
        },
    )
    body = json.loads(capsys.readouterr().out)
    assert code == 1
    assert body["ok"] is False
    assert body["status"] == "drift"
    assert (body["desired"], body["actual"]) == (2, 2)
    assert body["to_add"] == 1
    assert body["to_remove"] == 1
    assert body["to_add_sample"] == ["9.9.9.0/24"]
    assert body["last_runs"]["blocklist_sync"]["outcome"] == "ok"


def test_record_writes_one_worker_runs_row(monkeypatch, capsys):
    calls, code = _run(
        monkeypatch,
        ["--record"],
        d1_rows=["1.2.3.0/24"],
        list_items=["1.2.3.0/24"],
    )
    out = capsys.readouterr().out
    assert code == 0
    assert len(calls["writes"]) == 1
    sql = calls["writes"][0]
    assert "INSERT INTO worker_runs" in sql
    assert f"'{cbs.CHECK_JOB}'" in sql
    assert "'ok'" in sql
    assert sql.rstrip().endswith("0)")  # dry_run=0：检查不是演练
    assert f"recorded this check as {cbs.CHECK_JOB} outcome=ok" in out


def test_script_never_writes_to_the_ip_list(monkeypatch):
    """只读探测：整轮下来不许出现任何非 GET 的 Cloudflare 调用。"""
    calls, _ = _run(
        monkeypatch,
        [],
        d1_rows=["1.2.3.0/24"],
        list_items=["1.2.3.0/24"],
    )
    # cf_get_json 只做 GET（签名里没有 method 参数），且只命中 lists / items 两个只读端点。
    assert calls["cf"], "expected at least one Cloudflare read"
    assert all("/rules/lists" in url for url in calls["cf"])
