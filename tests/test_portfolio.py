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

"""作品区动态排版：卡片数量必须跟随 src/static/portfolio 里的图片数量。"""

import re

import pytest
from PIL import features

import build
import portfolio
from render_app import RENDER_APP


def test_list_portfolio_images_sorted_and_filtered(tmp_path):
    (tmp_path / "IMG_0002.webp").write_bytes(b"")
    (tmp_path / "IMG_0001.JPG").write_bytes(b"")
    (tmp_path / "note.txt").write_text("x", encoding="utf-8")
    (tmp_path / ".DS_Store").write_bytes(b"")

    assert portfolio.list_portfolio_images(str(tmp_path)) == [
        "IMG_0001.JPG",
        "IMG_0002.webp",
    ]


def test_portfolio_items_numbering_and_stem(tmp_path):
    for name in ("a.webp", "b.png"):
        (tmp_path / name).write_bytes(b"")

    items = portfolio.portfolio_items(str(tmp_path))

    assert [i["stem"] for i in items] == ["a", "b"]
    assert [i["num"] for i in items] == ["01", "02"]
    assert [i["ext"] for i in items] == ["webp", "png"]


def test_portfolio_items_falls_back_when_source_missing(tmp_path):
    items = portfolio.portfolio_items(str(tmp_path / "missing"))

    assert [i["name"] for i in items] == list(portfolio.FALLBACK_PORTFOLIO_IMAGES)


def test_home_renders_one_card_per_portfolio_image():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    items = portfolio.portfolio_items()

    assert html.count('class="work-box"') == len(items)
    for item in items:
        # 每张图都要有 AVIF + WebP 三档 srcset
        assert f"/static/portfolio/thumbs/{item['stem']}-800.avif" in html
        assert f"/static/portfolio/thumbs/{item['stem']}-640.webp" in html


def test_body_exposes_portfolio_thumbs_for_prefetch():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    match = re.search(r'data-portfolio-thumbs="([^"]*)"', html)

    assert match is not None
    assert match.group(1).split() == [
        f"/static/portfolio/thumbs/{item['stem']}-640.avif"
        for item in portfolio.portfolio_items()
    ]


def test_portfolio_items_expose_ratio_and_orientation(tmp_path):
    Image = pytest.importorskip("PIL.Image")

    for name, size in (
        ("portrait.webp", (1080, 1440)),
        ("landscape.webp", (1350, 900)),
        ("square.webp", (1000, 1000)),
    ):
        Image.new("RGB", size, "red").save(tmp_path / name, "WEBP")

    items = {i["stem"]: i for i in portfolio.portfolio_items(str(tmp_path))}

    # 比例为约分后的精确整数对（3:2 而不是 1.5 的近似值）
    assert items["portrait"]["ratio"] == "3 / 4"
    assert items["landscape"]["ratio"] == "3 / 2"
    assert items["square"]["ratio"] == "1 / 1"
    assert items["portrait"]["orientation"] == "portrait"
    assert items["landscape"]["orientation"] == "landscape"
    assert items["square"]["orientation"] == "square"


def test_home_cards_carry_per_image_aspect_ratio():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")

    # 每张卡片写出自己的画幅与固有尺寸，避免被统一裁成 3:4、也避免 CLS
    for item in portfolio.portfolio_items():
        assert f'style="aspect-ratio: {item["ratio"]}"' in html
        assert f'width="{item["width"]}" height="{item["height"]}"' in html
        assert f'data-orientation="{item["orientation"]}"' in html


def test_generate_portfolio_thumbs_writes_webp_and_avif(tmp_path):
    Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src"
    source.mkdir()
    Image.new("RGB", (1000, 1333), "red").save(source / "shot.webp", "WEBP")
    output = tmp_path / "out"

    count = build.generate_portfolio_thumbs(str(source), str(output))

    assert count == len(build.PORTFOLIO_THUMB_WIDTHS)
    for width in build.PORTFOLIO_THUMB_WIDTHS:
        assert (output / f"shot-{width}.webp").exists()
        assert (output / f"shot-{width}.avif").exists()


def test_thumbs_keep_source_aspect_ratio_in_both_formats(tmp_path):
    """3:2 / 2:3 / 3:4 源图：webp 与 avif 都必须等比，宽度按档位、高度按比例。"""
    Image = pytest.importorskip("PIL.Image")

    source = tmp_path / "src"
    source.mkdir()
    cases = {"p34": (1080, 1440), "l32": (1350, 900), "p23": (900, 1350)}
    for stem, size in cases.items():
        Image.new("RGB", size, "red").save(source / f"{stem}.webp", "WEBP")

    output = tmp_path / "out"
    build.generate_portfolio_thumbs(str(source), str(output))

    for stem, (src_w, src_h) in cases.items():
        for width in build.PORTFOLIO_THUMB_WIDTHS:
            expect_h = round(src_h * width / src_w)
            for ext in ("webp", "avif"):
                with Image.open(output / f"{stem}-{width}.{ext}") as im:
                    assert (im.width, im.height) == (width, expect_h), (
                        f"{stem}-{width}.{ext} 尺寸不符：{im.width}x{im.height}"
                    )


def test_avif_thumbs_are_decodable_and_not_webp(tmp_path):
    """AVIF 档位必须真的是 AVIF 容器，不能退化成 webp/原格式。"""
    Image = pytest.importorskip("PIL.Image")
    if not features.check("avif"):
        pytest.skip("当前 Pillow 没有 AVIF 编解码支持")

    source = tmp_path / "src"
    source.mkdir()
    Image.new("RGB", (1200, 800), "red").save(source / "wide.webp", "WEBP")
    output = tmp_path / "out"

    build.generate_portfolio_thumbs(str(source), str(output))

    for width in build.PORTFOLIO_THUMB_WIDTHS:
        path = output / f"wide-{width}.avif"
        assert path.read_bytes()[4:12] == b"ftypavif"
        with Image.open(path) as im:
            assert im.format == "AVIF"
            assert (im.width, im.height) == (width, round(800 * width / 1200))


def test_generate_portfolio_thumbs_skips_when_source_dir_missing(tmp_path):
    """CI 干净 checkout 没有源图目录：跳过而不报错，且不产生空目录噪音。"""
    output = tmp_path / "out"

    assert build.generate_portfolio_thumbs(str(tmp_path / "missing"), str(output)) == 0
    assert not output.exists()


def test_home_avif_and_webp_srcsets_cover_every_image():
    """首页每张图都要有 AVIF + WebP 两套 srcset，且档位一致。"""
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")

    for item in portfolio.portfolio_items():
        stem = item["stem"]
        for fmt in ("avif", "webp"):
            for width in build.PORTFOLIO_THUMB_WIDTHS:
                assert f"/thumbs/{stem}-{width}.{fmt} {width}w" in html
        # AVIF 优先、WebP 兜底：picture 里 AVIF 的 source 必须在 img 之前
        assert html.index(f"{stem}-800.avif") < html.index(f"{stem}-800.webp")

