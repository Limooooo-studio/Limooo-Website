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

"""Build the OFL gate subset; original outlines remain unchanged in the KR source.

Run with .venv-build/bin/python ops/fonts/build_gate_font.py SOURCE.ttf OUTPUT_DIR.
Only 위 and 치 are added; this is not a full Korean typeface.
"""
import argparse
import math
from pathlib import Path

from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont


def capsule(pen, a, b, width=96):
    """Clockwise outline with quadratic rounded caps."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    nx, ny = -uy * width / 2, ux * width / 2
    r = width / 2
    pen.moveTo((a[0] + nx, a[1] + ny))
    pen.lineTo((b[0] + nx, b[1] + ny))
    pen.qCurveTo((b[0] + nx + ux*r, b[1] + ny + uy*r), (b[0]+ux*r, b[1]+uy*r))
    pen.qCurveTo((b[0] - nx + ux*r, b[1] - ny + uy*r), (b[0]-nx, b[1]-ny))
    pen.lineTo((a[0]-nx, a[1]-ny))
    pen.qCurveTo((a[0]-nx-ux*r, a[1]-ny-uy*r), (a[0]-ux*r, a[1]-uy*r))
    pen.qCurveTo((a[0]+nx-ux*r, a[1]+ny-uy*r), (a[0]+nx, a[1]+ny))
    pen.closePath()


def ellipse(pen, cx, cy, rx, ry, reverse=False):
    # Eight quadratic arcs; inner contour has the opposite winding.
    points = []
    for i in range(8):
        t = (-1 if not reverse else 1) * i * math.pi / 4
        points.append((cx+rx*math.cos(t), cy+ry*math.sin(t)))
    pen.moveTo(points[0])
    for i in range(8):
        t = (-1 if not reverse else 1) * (i+.5) * math.pi/4
        pen.qCurveTo((cx+rx*math.cos(t)/math.cos(math.pi/8), cy+ry*math.sin(t)/math.cos(math.pi/8)), points[(i+1)%8])
    pen.closePath()


def hangul(cp):
    p = TTGlyphPen(None)
    if cp == 0xC704:  # 위: ㅇ above ㅜ, with ㅣ on the right
        ellipse(p, 455, 605, 230, 190)
        ellipse(p, 455, 605, 134, 94, reverse=True)
        capsule(p, (180, 270), (730, 270))
        capsule(p, (455, 220), (455, -25))
    else:  # 치: ㅊ on the left, ㅣ on the right
        capsule(p, (435, 810), (455, 750), 90)
        capsule(p, (205, 605), (705, 605))
        # Curved descending strokes echo the original CJK 人 / 文 terminals.
        raw = p
        p = ReverseContourPen(raw)
        p.moveTo((407, 555))
        p.qCurveTo((403, 290), (164, 109))
        p.qCurveTo((128, 77), (163, 40))
        p.qCurveTo((185, 17), (218, 42))
        p.qCurveTo((493, 240), (503, 551))
        p.qCurveTo((504, 599), (456, 601))
        p.qCurveTo((408, 601), (407, 555))
        p.closePath()
        p.moveTo((407, 447))
        p.qCurveTo((462, 200), (691, 29))
        p.qCurveTo((723, 5), (751, 42))
        p.qCurveTo((781, 80), (745, 106))
        p.qCurveTo((550, 252), (503, 467))
        p.qCurveTo((492, 515), (446, 504))
        p.qCurveTo((399, 494), (407, 447))
        p.closePath()
        p = raw
    capsule(p, (960, 820), (960, -60))
    glyph = p.glyph()
    # Overlapping strokes use the same winding and explicitly advertise overlap.
    glyph.flags[0] |= 0x40
    return glyph


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    f = TTFont(args.source, recalcTimestamp=False)
    assert f['head'].unitsPerEm == 1000
    original = {n: f['glyf'][n].compile(f['glyf']) for n in f.getGlyphOrder()}
    metrics = dict(f['hmtx'].metrics)
    for cp in (0xC704, 0xCE58):
        assert cp not in f.getBestCmap(), 'Source already has Korean; review before replacing'
        name = f'uni{cp:04X}'
        f.setGlyphOrder(f.getGlyphOrder() + [name])
        f['glyf'][name] = hangul(cp)
        f['glyf'][name].recalcBounds(f['glyf'])
        f['hmtx'][name] = (1200, f['glyf'][name].xMin)
        for table in f['cmap'].tables:
            if table.isUnicode() and table.format in (4, 12):
                table.cmap[cp] = name
    full = args.output / 'MapleMono-NF-CN-KR-Regular.ttf'
    f.save(full)
    check = TTFont(full)
    assert all(check['glyf'][n].compile(check['glyf']) == data for n, data in original.items())
    assert all(check['hmtx'][n] == value for n, value in metrics.items())
    opts = Options()
    opts.flavor = 'woff2'
    opts.hinting = False
    opts.layout_features = ['*']
    ss = Subsetter(options=opts)
    required = set(range(0x20, 0x7F)) | {0x2014, 0x4F4D, 0x7F6E, 0x5834, 0x6240, 0xC704, 0xCE58}
    ss.populate(unicodes=required)
    ss.subset(f)
    f.flavor = 'woff2'
    out = args.output / 'maple-mono-nf-cn-regular-subset.woff2'
    f.save(out)
    check = TTFont(out)
    assert required <= check.getBestCmap().keys()
    for cp in (0xC704, 0xCE58):
        assert check['hmtx'][check.getBestCmap()[cp]][0] == 1200
    print(f'Validated {len(original)} unchanged outlines and metrics; {out.stat().st_size} bytes WOFF2')


if __name__ == '__main__':
    main()
