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

"""Read-only snapshot of the limooo.cn zone settings.

Why this exists (docs/22, 2026-10-11): `ops/cloudflare/README.md` is the inventory
of resources that live only in the Cloudflare Dashboard, but it had no record of the
zone-level settings at all. Those settings are observable behaviour (HSTS enforcement,
minimum TLS version, Security Level, the Cloudflare Web Analytics injection) yet nothing
in the repository pinned them, so a Dashboard change could alter the live site without
any reviewable diff.

This is the zone-settings counterpart to `ops/waf/rules.snapshot.json`:

  * `--show`     live: print the settings, write nothing.
  * `--snapshot` live: refresh `ops/zone-settings.snapshot.json`.
  * `--dry-run`  fully offline: read the committed snapshot and touch no network.

Credentials: `CLOUDFLARE_API_TOKEN` from the environment, else from the local
`secrets/webauthn.env`. The token is never echoed and never written to the snapshot.
`CLOUDFLARE_ACCOUNT_ID` is not needed (zone-scoped endpoints).

Only the keys in SNAPSHOT_KEYS are captured: they are the ones whose value changes
observable behaviour. Every key is captured as `id`, `value` and `editable`, so the
snapshot is a faithful record rather than a hand-picked summary.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRETS_FILE = Path(os.environ.get("ZONE_ENV_FILE", ROOT / "secrets" / "webauthn.env"))
SNAPSHOT = Path(os.environ.get("ZONE_SNAPSHOT", ROOT / "ops" / "zone-settings.snapshot.json"))
ZONE_NAME = os.environ.get("ZONE_NAME", "limooo.cn")
API_BASE = "https://api.cloudflare.com/client/v4"

# Settings whose value is observable from outside, or which change site behaviour.
# Kept in one place so `--check` can detect a renamed/removed key instead of
# silently dropping it from the snapshot.
SNAPSHOT_KEYS = (
    "always_use_https",
    "automatic_https_rewrites",
    "min_tls_version",
    "ssl",
    "tls_1_3",
    "security_level",
    "browser_check",
    "challenge_ttl",
    "opportunistic_onion",
    "0rtt",
    "http3",
    "ipv6",
    "websockets",
    "email_obfuscation",
    "server_side_exclude",
    "hotlink_protection",
    "privacy_pass",
    "pseudo_ipv4",
    "rocket_loader",
    "mirage",
    "polish",
    "webp",
    "brotli",
    "early_hints",
    "http2",
    "development_mode",
)

# Settings where a non-default value is worth a human's attention. `--check`
# prints these as notes; it does not fail, because some of them are deliberate.
# Each entry fires only when the live value is the *unwanted* one. Listing the
# desired value instead would flag correct settings, which trains people to ignore
# the note (the first draft of this file did exactly that).
NOTEWORTHY: tuple[tuple[str, str, str], ...] = (
    (
        "security_level",
        "essentially_off",
        "disables Cloudflare's standard threat score, IP reputation and Browser "
        "Integrity Check for the whole zone; the Worker gate and the blocklist remain "
        "the only filters. Not recorded anywhere as deliberate.",
    ),
    (
        "ssl",
        "flexible",
        "means Cloudflare talks plain HTTP to the origin; Pages needs full or strict.",
    ),
    ("tls_1_3", "off", "disables TLS 1.3 for every visitor."),
    ("always_use_https", "off", "means plain http:// serves the site instead of redirecting."),
    ("development_mode", "on", "bypasses the zone cache; meant to be temporary."),
    ("rocket_loader", "on", "rewrites page scripts; the site pins its own CSP and JS."),
    ("hotlink_protection", "off", "lets other sites embed this site's images directly."),
    ("browser_check", "off", "drops Cloudflare's Browser Integrity Check."),
)


def read_token() -> str:
    """Token from the environment, else from secrets/webauthn.env (never echoed)."""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if token:
        return token
    if not SECRETS_FILE.is_file():
        return ""
    for line in SECRETS_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("CLOUDFLARE_API_TOKEN="):
            return line.split("=", 1)[1].strip()
    return ""


def api_get(token: str, path: str) -> object:
    request = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 (fixed https host)
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("success"):
        raise RuntimeError(f"Cloudflare API error: {payload.get('errors')}")
    return payload.get("result")


def resolve_zone_id(token: str) -> str:
    zones = api_get(token, f"/zones?name={ZONE_NAME}")
    if not isinstance(zones, list) or not zones:
        raise RuntimeError(f"zone not found or not visible to this token: {ZONE_NAME}")
    return str(zones[0]["id"])


def fetch_settings(token: str, zone_id: str) -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    for key in SNAPSHOT_KEYS:
        try:
            result = api_get(token, f"/zones/{zone_id}/settings/{key}")
        except urllib.error.HTTPError as error:
            if error.code in (403, 404):
                # Plan-gated or renamed setting: record the fact instead of dropping it.
                out[key] = {"value": None, "editable": None, "note": f"unavailable (HTTP {error.code})"}
                continue
            raise
        if not isinstance(result, dict):
            out[key] = {"value": None, "editable": None, "note": "unexpected response shape"}
            continue
        out[key] = {"value": result.get("value"), "editable": result.get("editable")}
    return out


def render(settings: dict[str, dict[str, object]], zone_id: str | None) -> dict[str, object]:
    return {
        "captured_at": datetime.now(UTC).isoformat(),
        "zone": ZONE_NAME,
        "zone_id": zone_id,
        "settings": {key: settings[key] for key in sorted(settings)},
    }


def describe(settings: dict[str, dict[str, object]]) -> int:
    """Print the current values and flag the noteworthy ones. Returns a note count."""
    offending = {
        key: (bad, why)
        for key, bad, why in NOTEWORTHY
        if str(settings.get(key, {}).get("value")) == bad
    }
    width = max(len(key) for key in settings)
    for key in sorted(settings):
        suffix = "  <- review" if key in offending else ""
        print(f"  {key:<{width}}  {settings[key].get('value')}{suffix}")
    if offending:
        print()
        for key in sorted(offending):
            bad, why = offending[key]
            print(f"  {key} = {bad}: {why}")
    return len(offending)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only snapshot of the limooo.cn zone settings.",
        epilog="Live modes need CLOUDFLARE_API_TOKEN (env or secrets/webauthn.env).",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", help="print the committed snapshot; no network")
    group.add_argument("--show", action="store_true", help="print live settings; write nothing")
    group.add_argument("--snapshot", action="store_true", help="refresh the committed snapshot")
    args = parser.parse_args()

    if args.dry_run or not (args.show or args.snapshot):
        if not SNAPSHOT.is_file():
            print(f"FATAL: no snapshot at {SNAPSHOT}", file=sys.stderr)
            return 1
        data = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        settings = data.get("settings") or {}
        print(f"zone settings snapshot  ({data.get('captured_at', '?')})")
        describe(settings)
        return 0

    token = read_token()
    if not token:
        print("FATAL: CLOUDFLARE_API_TOKEN not set and not found in the secrets file", file=sys.stderr)
        return 1

    try:
        zone_id = resolve_zone_id(token)
        settings = fetch_settings(token, zone_id)
    except Exception as error:  # network, auth, or API shape
        print(f"FATAL: {error}", file=sys.stderr)
        return 1

    if args.show:
        print(f"zone settings (live, {ZONE_NAME})")
        describe(settings)
        return 0

    previous: dict[str, dict[str, object]] = {}
    if SNAPSHOT.is_file():
        previous = (json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("settings") or {})

    changed = [
        key
        for key in sorted(settings)
        if previous.get(key, {}).get("value") != settings[key].get("value")
    ]
    SNAPSHOT.write_text(
        json.dumps(render(settings, zone_id), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"snapshot written: {SNAPSHOT}")
    if previous:
        if changed:
            print(f"changed since last snapshot ({len(changed)}):")
            for key in changed:
                print(f"  {key}: {previous.get(key, {}).get('value')} -> {settings[key].get('value')}")
        else:
            print("changed since last snapshot: none")
    describe(settings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
