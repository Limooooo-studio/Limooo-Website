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

"""`requirements.lock` must stay in step with `ops/requirements.txt`.

The regression this guards is concrete (docs/22, 2026-10-11): Dependabot bumped
`cairosvg` to 2.9.1 in `ops/requirements.txt`, CI went green, the PR was merged — and
nothing changed, because `ops/build.sh:56` installs **requirements.lock**, which still
pinned 2.8.2. Six other packages had drifted the same way.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops"))

import check_requirements_lock as guard  # noqa: E402  (path is set above)


def test_the_real_repository_is_consistent() -> None:
    """The committed pair must agree; this is the assertion CI relies on."""
    txt = guard.read_pins(guard.TXT)
    lock = guard.read_pins(guard.LOCK)

    assert txt, "ops/requirements.txt parsed to nothing"
    assert lock, "requirements.lock parsed to nothing"
    assert guard.check_pins(txt, lock) == []


def test_no_dev_only_tool_leaks_into_the_lock() -> None:
    """ruff/mypy/pytest-cov must never be pinned in the lock.

    Note the direction: this does NOT assert that the two sets are equal, because the
    lock legitimately carries transitive dependencies (Flask pulls Werkzeug, Jinja2,
    MarkupSafe, ...). The lock may therefore be a superset of requirements.txt; what it
    may never contain is one of the gate tools.
    """
    txt = guard.read_pins(guard.TXT)
    lock = guard.read_pins(guard.LOCK)

    assert not (set(lock) & guard.DEV_ONLY), "a dev-only gate tool leaked into the lock"
    # The extra entries must all be known transitive dependencies, not stray typos.
    # 实测（2026-10-11）：lock 比 requirements.txt 多出这 16 个传递依赖。
    # 它们各自由 cairosvg / cryptography / flask / pillow / requests 拉进来。
    expected_extra = {
        "blinker", "cairocffi", "certifi", "cffi", "charset-normalizer", "click",
        "cssselect2", "defusedxml", "idna", "itsdangerous", "jinja2", "markupsafe",
        "pycparser", "tinycss2", "urllib3", "werkzeug",
    }
    assert set(lock) - set(txt) == expected_extra, (
        "the lock gained a package that is neither declared nor a known transitive dep"
    )


def test_a_version_mismatch_is_reported() -> None:
    """Exactly the cairosvg case: the source of truth moved, the lock did not."""
    problems = guard.check_pins({"cairosvg": "2.9.1"}, {"cairosvg": "2.8.2"})

    assert len(problems) == 1
    assert "2.9.1" in problems[0] and "2.8.2" in problems[0]
    # 报错必须点明"lock 才是 build.sh 装的那个"，否则读者不知道哪个才算数。
    assert "build.sh" in problems[0]


def test_a_missing_runtime_pin_is_reported() -> None:
    problems = guard.check_pins({"cairosvg": "2.9.1"}, {})

    assert len(problems) == 1
    assert "missing from" in problems[0]


def test_dev_only_tools_are_allowed_only_in_requirements_txt() -> None:
    """ruff/mypy/pytest-cov belong in ops/requirements.txt and nowhere else."""
    assert guard.check_pins({"ruff": "0.17.0"}, {}) == []

    problems = guard.check_pins({"ruff": "0.17.0"}, {"ruff": "0.17.0"})
    assert len(problems) == 1
    assert "must not be pinned" in problems[0]


def test_read_pins_ignores_comments_and_blank_lines(tmp_path: Path) -> None:
    """The lock carries a long explanatory header; parsing must not trip on it."""
    target = tmp_path / "requirements.lock"
    target.write_text(
        "# a comment with == inside\n"
        "\n"
        "CairoSVG==2.9.1\n"
        "  # indented comment\n"
        "Werkzeug==3.1.9\n",
        encoding="utf-8",
    )

    assert guard.read_pins(target) == {"cairosvg": "2.9.1", "werkzeug": "3.1.9"}
