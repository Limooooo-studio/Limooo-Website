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

"""services.limooo.cn 价目表：CSV 是唯一数据源，构建时读取。"""

import re

import pytest

import build
from render_app import RENDER_APP
from services_pricing import (
    CONVENTION_CSV,
    OUTDOOR_CSV,
    load_pricing,
)


def _write(dir_path, name, text):
    path = dir_path / name
    path.write_text(text, encoding="utf-8")
    return path


# 这里曾经有一个 autouse fixture 在每个用例前后调 render_app._cached_pricing.cache_clear()：
# 当时缓存把 SERVICES_DIR 闭包在 import 期，换目录不会失配。现在 render_app 的缓存
# **以目录为 key**（`_cached_pricing(services_dir)`，见 render_app 里那段注释），
# 换目录自然 miss，兜底失效逻辑已成死代码，故删除。
# 回归保护在 tests/test_build_w4.py：test_two_services_dirs_do_not_cross_pollute
# （两个临时目录连续渲染，**不调用** cache_clear，断言互不污染）。


@pytest.fixture
def services_dir(tmp_path, monkeypatch):
    """把价目表目录指向临时目录，避免测试依赖仓库里的真实 CSV 内容。"""
    monkeypatch.setattr("services_pricing.SERVICES_DIR", str(tmp_path))
    return tmp_path


def test_load_pricing_reads_both_csv(services_dir):
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\nstudio,solo,100\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
    )

    pricing = load_pricing()

    assert [plan["price"] for plan in pricing["convention"]] == [20, 55, 100, 150]
    assert [plan["unit_key"] for plan in pricing["convention"]] == [
        "unit_per_shot",
        "unit_per_3",
        "unit_per_6",
        "unit_per_9",
    ]
    assert [plan["plan_key"] for plan in pricing["outdoor"]] == [
        "plan_studio_solo",
        "plan_studio_duo",
        "plan_outdoor_solo",
        "plan_outdoor_duo",
    ]
    assert [plan["price"] for plan in pricing["outdoor"]] == [100, 150, 120, 180]


def test_convention_rows_are_sorted_by_shot_count(services_dir):
    _write(services_dir, CONVENTION_CSV, "shots,price\n9,150\n1,20\n6,100\n3,55\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\nstudio,solo,100\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
    )

    pricing = load_pricing()

    assert [plan["shots"] for plan in pricing["convention"]] == [1, 3, 6, 9]


def test_outdoor_rows_are_rendered_in_fixed_order(services_dir):
    """CSV 行序变化不应打乱四张卡片的版式（棚拍在前、外景在后）。"""
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\noutdoor,duo,180\nstudio,solo,100\noutdoor,solo,120\nstudio,duo,150\n",
    )

    pricing = load_pricing()

    assert [plan["price"] for plan in pricing["outdoor"]] == [100, 150, 120, 180]


@pytest.mark.parametrize(
    "bookable,expected",
    [
        ("yes", [False, False, False, False]),
        ("no", [True, True, True, True]),
        ("", [False, False, False, False]),
        (None, [False, False, False, False]),
    ],
)
def test_bookable_column_drives_the_strikethrough(services_dir, bookable, expected):
    """`bookable` = no 加删除线；= yes 或留空（含整列不存在）都不加。"""
    column = "" if bookable is None else ",bookable"
    cells = [bookable] * 4 if bookable is not None else [None] * 4

    def row(kind, who, price, cell):
        base = f"{kind},{who},{price}"
        return base if cell is None else f"{base},{cell}"

    _write(
        services_dir,
        CONVENTION_CSV,
        "shots,price" + column + "\n"
        + "\n".join(
            f"{shots},{price}" + ("" if bookable is None else f",{bookable}")
            for shots, price in ((1, 20), (3, 55), (6, 100), (9, 150))
        )
        + "\n",
    )
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price" + column + "\n"
        + "\n".join(
            row(kind, who, price, cells[i])
            for i, (kind, who, price) in enumerate(
                (
                    ("studio", "solo", 100),
                    ("studio", "duo", 150),
                    ("outdoor", "solo", 120),
                    ("outdoor", "duo", 180),
                )
            )
        )
        + "\n",
    )

    pricing = load_pricing()

    assert [plan["strikethrough"] for plan in pricing["outdoor"]] == expected
    assert [plan["strikethrough"] for plan in pricing["convention"]] == expected


@pytest.mark.parametrize(
    "studio,expected",
    [
        # 两档棚拍都不接 → 说明栏显示暂停文案
        (("no", "no"), "studio_paused"),
        # 只要有一档还接单 → 说明栏显示可预约，不能和卡片上的删除线自相矛盾
        (("yes", "yes"), "studio_bookable"),
        (("yes", "no"), "studio_bookable"),
        # 留空同样算接单
        (("", ""), "studio_bookable"),
    ],
)
def test_studio_note_row_follows_the_bookable_column(services_dir, studio, expected):
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price,bookable\n"
        f"studio,solo,100,{studio[0]}\nstudio,duo,150,{studio[1]}\n"
        "outdoor,solo,120,yes\noutdoor,duo,180,yes\n",
    )

    pricing = load_pricing()

    assert pricing["outdoor_note"] == {
        "title_key": "extra_studio",
        "value_key": expected,
    }


def test_studio_note_row_is_rendered(services_dir):
    """说明栏那一行必须由模板渲染出来；棚拍全不接时显示暂停文案。"""
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price,bookable\n"
        "studio,solo,100,no\nstudio,duo,150,no\noutdoor,solo,120,yes\noutdoor,duo,180,yes\n",
    )

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")

    assert 'data-i18n="extra_studio"' in html
    assert 'data-i18n="studio_paused"' in html
    assert 'data-i18n="studio_bookable"' not in html


def test_invalid_bookable_value_fails_the_build(services_dir):
    _write(services_dir, CONVENTION_CSV, "shots,price,bookable\n1,20,maybe\n3,55,yes\n6,100,yes\n9,150,yes\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price,bookable\nstudio,solo,100,yes\nstudio,duo,150,yes\noutdoor,solo,120,yes\noutdoor,duo,180,yes\n",
    )

    with pytest.raises(RuntimeError) as excinfo:
        load_pricing()

    assert "bookable" in str(excinfo.value) and "unrecognized" in str(excinfo.value)


@pytest.mark.parametrize(
    "convention,outdoor,message",
    [
        ("shots,price\n1,20\n3,55\n6,100\n9,150\n", "type,people,price\nstudio,solo,100\n", "missing tier"),
        ("shots\n1\n3\n6\n9\n", None, "missing column"),
    ],
)
def test_invalid_csv_fails_the_build(services_dir, convention, outdoor, message):
    _write(services_dir, CONVENTION_CSV, convention)
    if outdoor is not None:
        _write(services_dir, OUTDOOR_CSV, outdoor)

    with pytest.raises(RuntimeError) as excinfo:
        load_pricing()

    assert message in str(excinfo.value)


def test_missing_csv_fails_the_build(services_dir):
    with pytest.raises(RuntimeError) as excinfo:
        load_pricing()

    assert "cannot read price list" in str(excinfo.value)


def test_services_page_renders_csv_prices(services_dir):
    """模板里的价格必须来自 CSV，而不是写死的常量。"""
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,30\n3,60\n6,110\n9,160\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price,bookable\n"
        "studio,solo,110,no\nstudio,duo,160,no\noutdoor,solo,130,yes\noutdoor,duo,190,\n",
    )
    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")

    assert re.findall(r'<span class="price-num">CNY (\d+)', html) == [
        "30",
        "60",
        "110",
        "160",
        "110",
        "160",
        "130",
        "190",
    ]
    # 档位标签与单位后缀仍然走 i18n
    assert 'data-i18n="plan_studio_solo"' in html
    assert 'data-i18n="unit_per_9"' in html
    # 棚拍两档「是否接单=否」→ 删除线；外景两档不加
    assert html.count('class="plan-price strikethrough"') == 2


@pytest.mark.parametrize(
    "literal",
    ["N/A", "n/a", "NA", " N/A ", "TBD", "", "1OO", "0", "-5", "12.5"],
)
def test_non_positive_integer_price_renders_dash(services_dir, literal):
    """价格没有白名单：解析不出正整数（N/A / 留空 / 写错 / 0 / 负数）→ no_price，构建照常通过。"""
    _write(
        services_dir,
        CONVENTION_CSV,
        f"shots,price\n1,{literal}\n3,55\n6,100\n9,150\n",
    )
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\n"
        f"studio,solo,{literal}\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
    )

    pricing = load_pricing()

    assert pricing["convention"][0]["price"] is None
    assert pricing["convention"][0]["no_price"] is True
    assert pricing["convention"][1]["no_price"] is False
    assert pricing["outdoor"][0]["price"] is None
    assert pricing["outdoor"][0]["no_price"] is True
    assert [plan["no_price"] for plan in pricing["outdoor"]] == [
        True,
        False,
        False,
        False,
    ]


def test_no_price_renders_as_dash(services_dir):
    """没有价格只把数字换成 '-'：CNY 前缀与单位后缀留在原位，同页其他档位照旧。"""
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,N/A\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\nstudio,solo,TBD\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,0\n",
    )

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")

    # 场照带单位后缀（/ 张），正片带 / 小时；前缀都不省
    assert '<span class="price-num">CNY -<span class="plan-unit" data-i18n="unit_per_shot">' in html
    assert (
        html.count(
            '<span class="price-num">CNY -<span class="plan-unit" data-i18n="unit_per_hour">'
        )
        == 2
    )
    assert "N/A" not in html
    assert "TBD" not in html
    assert "CNY None" not in html
    assert re.findall(r'<span class="price-num">CNY (\d+)', html) == [
        "55",
        "100",
        "150",
        "150",
        "120",
    ]


def test_services_page_matches_committed_csv():
    """仓库里真实的 CSV 必须能渲染（防止只改 CSV 改坏格式就提交/部署）。"""
    pricing = load_pricing()

    assert pricing["convention"], "convention.csv must have at least one tier"
    assert len(pricing["outdoor"]) == 4
    # 张数升序且不重复
    shots = [plan["shots"] for plan in pricing["convention"]]
    assert shots == sorted(shots) and len(set(shots)) == len(shots)

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")
    # 每个档位都必须渲染出一个价格格（数字或 '-'），数量跟 CSV 对齐
    assert html.count('<span class="price-num">') == len(pricing["convention"]) + 4
    assert "None" not in html


def test_overflow_price_column_renders_dash(services_dir):
    """价格列多一个逗号（`1,000`）不能让构建抛 AttributeError。

    数据行字段数多于表头时，csv.DictReader 把溢出的列塞进 row[None]（值是 list）。
    约定是「解析不出正整数就渲染 '-'，构建永不因此失败」，所以溢出列要归一化成
    字符串（"1,000"）交给 _parse_price，自然得到 None。
    """
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,1,000\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\nstudio,solo,1,000\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
    )

    pricing = load_pricing()

    assert pricing["convention"][0]["price"] is None
    assert pricing["convention"][0]["no_price"] is True
    assert [plan["price"] for plan in pricing["convention"]] == [None, 55, 100, 150]
    assert pricing["outdoor"][0]["price"] is None
    assert pricing["outdoor"][0]["no_price"] is True

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")

    # 溢出的那一档只把数字换成 '-'：CNY 前缀与单位后缀留在原位，其他档位照旧
    assert '<span class="price-num">CNY -<span class="plan-unit" data-i18n="unit_per_shot">' in html
    assert re.findall(r'<span class="price-num">CNY (\d+)', html) == [
        "55",
        "100",
        "150",
        "150",
        "120",
        "180",
    ]
    assert "1,000" not in html
    assert "CNY None" not in html


@pytest.mark.parametrize(
    "filename,text",
    [
        (CONVENTION_CSV, "shots,price,price\n1,20\n3,55\n6,100\n9,150\n"),
        (
            OUTDOOR_CSV,
            "type,people,price,price\n"
            "studio,solo,100\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
        ),
    ],
)
def test_duplicate_header_fails_the_build(services_dir, filename, text):
    """重复表头（`shots,price,price`）会静默取最后一列——必须报错，且报错要带文件名。"""
    _write(services_dir, CONVENTION_CSV, "shots,price\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "type,people,price\nstudio,solo,100\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
    )
    _write(services_dir, filename, text)

    with pytest.raises(RuntimeError) as excinfo:
        load_pricing()

    assert filename in str(excinfo.value)
    assert "duplicate" in str(excinfo.value)
