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

"""Zone-settings snapshot: what the review note fires on, and what it must not.

The first draft of `ops/zone_settings.py` flagged `always_use_https=on` and
`tls_1_3=zrt` — the *desired* values — which is how a review note becomes noise
nobody reads. These tests pin the corrected rule: a note only appears when the live
value is the unwanted one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ops"))

import zone_settings  # noqa: E402  (path is set above)


def values(**overrides: object) -> dict[str, dict[str, object]]:
    """A full setting map with the production values, then apply overrides."""
    base = {
        "always_use_https": "on",
        "automatic_https_rewrites": "on",
        "min_tls_version": "1.2",
        "ssl": "full",
        "tls_1_3": "zrt",
        "security_level": "essentially_off",
        "browser_check": "on",
        "challenge_ttl": 1800,
        "development_mode": "off",
        "hotlink_protection": "on",
        "rocket_loader": "off",
    }
    base.update(overrides)
    return {key: {"value": value, "editable": True} for key, value in base.items()}


def test_only_security_level_is_flagged_in_production(capsys: pytest.CaptureFixture[str]) -> None:
    """Production values produce exactly one note, and it is Security Level."""
    notes = zone_settings.describe(values())

    assert notes == 1, "production settings should raise exactly one review note"
    out = capsys.readouterr().out
    assert "security_level            essentially_off  <- review" in out
    # The desired values must never be flagged: that was the first draft's bug.
    for benign in ("always_use_https", "tls_1_3", "ssl", "browser_check", "hotlink_protection"):
        assert f"{benign}" in out
    assert out.count("<- review") == 1


def test_hardening_a_setting_silences_its_note() -> None:
    """Changing Security Level to a real level removes the only note."""
    assert zone_settings.describe(values(security_level="medium")) == 0


@pytest.mark.parametrize(
    ("key", "bad"),
    [
        ("ssl", "flexible"),
        ("tls_1_3", "off"),
        ("always_use_https", "off"),
        ("development_mode", "on"),
        ("rocket_loader", "on"),
        ("hotlink_protection", "off"),
        ("browser_check", "off"),
    ],
)
def test_each_guarded_setting_fires_on_its_bad_value(
    key: str,
    bad: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    notes = zone_settings.describe(values(security_level="medium", **{key: bad}))

    assert notes == 1
    assert f"  {key} = {bad}:" in capsys.readouterr().out


def test_committed_snapshot_covers_every_guarded_key() -> None:
    """The snapshot must carry every key the review logic looks at.

    Otherwise a rename upstream would silently stop being reviewed — the failure
    mode this whole tool exists to prevent.
    """
    snapshot = ROOT / "ops" / "zone-settings.snapshot.json"
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    settings = data["settings"]

    missing = [key for key, _bad, _why in zone_settings.NOTEWORTHY if key not in settings]
    assert missing == [], f"guarded keys missing from the snapshot: {missing}"
    assert data["zone"] == "limooo.cn"
    assert set(zone_settings.SNAPSHOT_KEYS) == set(settings), (
        "snapshot drifted from SNAPSHOT_KEYS: regenerate with --snapshot"
    )


def test_snapshot_holds_no_credentials() -> None:
    """The snapshot is committed, so it must never contain a token or secret."""
    raw = (ROOT / "ops" / "zone-settings.snapshot.json").read_text(encoding="utf-8").lower()

    for needle in ("token", "secret", "bearer", "authorization"):
        assert needle not in raw, f"snapshot mentions {needle!r}"
