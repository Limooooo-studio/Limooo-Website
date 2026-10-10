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

"""docs/22 W7-12: the edge fallback message must match what the code does.

`ops/check_ray_id.py` claims "falling back to the aggregated dataset" only when
the per-request dataset is denied for lack of permission. Any other failure is
*not* a fallback: the aggregated dataset carries no Ray ID, so the lookup cannot
be answered from it and the script has to say so instead of pretending.
"""

from __future__ import annotations

import ops.check_ray_id as cri

ZONE = "zone-id"
RAY = "a334352fe9806564"


def test_permission_error_falls_back_to_the_aggregated_dataset(monkeypatch) -> None:
    calls: list[str] = []

    def fake_gql(cfg, query):
        calls.append(query)
        if "httpRequestsAdaptive(" in query:
            raise RuntimeError("not entitled to access to the field rayname")
        return {
            "viewer": {
                "zones": [
                    {
                        "httpRequestsAdaptiveGroups": [
                            {
                                "count": 2,
                                "dimensions": {
                                    "datetime": "2026-10-11T00:00:00Z",
                                    "clientIP": "203.0.113.7",
                                    "clientRequestHTTPHost": "limooo.cn",
                                    "clientRequestPath": "/",
                                    "clientRequestHTTPMethodName": "GET",
                                    "edgeResponseStatus": 200,
                                    "clientCountryName": "CN",
                                    "coloCode": "AMS",
                                },
                            }
                        ]
                    }
                ]
            }
        }

    monkeypatch.setattr(cri, "gql", fake_gql)
    rows, note = cri.edge_lookup({}, ZONE, RAY, "AMS", 30)

    assert len(calls) == 2, "the permission error must actually fall back (2 queries)"
    assert rows and rows[0].endswith("[edge]")
    assert "cannot read the per-request dataset" in note
    assert "NOT records of this Ray ID" in note


def test_other_failures_do_not_claim_a_fallback(monkeypatch) -> None:
    def boom(cfg, query):
        raise RuntimeError("connection reset by peer")

    monkeypatch.setattr(cri, "gql", boom)
    rows, note = cri.edge_lookup({}, ZONE, RAY, "AMS", 30)

    assert rows == []
    assert "no aggregated fallback was attempted" in note
    assert "falling back" not in note
    assert "cannot read the per-request dataset" not in note
