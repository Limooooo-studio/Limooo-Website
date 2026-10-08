"""services.limooo.cn 价目表：CSV 是唯一数据源，构建时读取。"""

import re

import build
import pytest
from render_app import RENDER_APP
from services_pricing import (
    CONVENTION_CSV,
    OUTDOOR_CSV,
    SERVICES_DIR,
    load_pricing,
)


def _write(dir_path, name, text):
    path = dir_path / name
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def services_dir(tmp_path, monkeypatch):
    """把价目表目录指向临时目录，避免测试依赖仓库里的真实 CSV 内容。"""
    monkeypatch.setattr("services_pricing.SERVICES_DIR", str(tmp_path))
    return tmp_path


def test_load_pricing_reads_both_csv(services_dir):
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格\n棚拍,单人,100\n棚拍,双人,150\n外景,单人,120\n外景,双人,180\n",
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
    _write(services_dir, CONVENTION_CSV, "张数,价格\n9,150\n1,20\n6,100\n3,55\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格\n棚拍,单人,100\n棚拍,双人,150\n外景,单人,120\n外景,双人,180\n",
    )

    pricing = load_pricing()

    assert [plan["shots"] for plan in pricing["convention"]] == [1, 3, 6, 9]


def test_outdoor_rows_are_rendered_in_fixed_order(services_dir):
    """CSV 行序变化不应打乱四张卡片的版式（棚拍在前、外景在后）。"""
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格\n外景,双人,180\n棚拍,单人,100\n外景,单人,120\n棚拍,双人,150\n",
    )

    pricing = load_pricing()

    assert [plan["price"] for plan in pricing["outdoor"]] == [100, 150, 120, 180]


@pytest.mark.parametrize(
    "bookable,expected",
    [
        ("是", [False, False, False, False]),
        ("否", [True, True, True, True]),
        ("", [False, False, False, False]),
        (None, [False, False, False, False]),
    ],
)
def test_bookable_column_drives_the_strikethrough(services_dir, bookable, expected):
    """「是否接单」= 否 加删除线；= 是 或留空（含整列不存在）都不加。"""
    column = "" if bookable is None else f",是否接单"
    cells = [bookable] * 4 if bookable is not None else [None] * 4

    def row(kind, who, price, cell):
        base = f"{kind},{who},{price}"
        return base if cell is None else f"{base},{cell}"

    _write(
        services_dir,
        CONVENTION_CSV,
        "张数,价格" + column + "\n"
        + "\n".join(
            f"{shots},{price}" + ("" if bookable is None else f",{bookable}")
            for shots, price in ((1, 20), (3, 55), (6, 100), (9, 150))
        )
        + "\n",
    )
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格" + column + "\n"
        + "\n".join(
            row(kind, who, price, cells[i])
            for i, (kind, who, price) in enumerate(
                (
                    ("棚拍", "单人", 100),
                    ("棚拍", "双人", 150),
                    ("外景", "单人", 120),
                    ("外景", "双人", 180),
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
        (("否", "否"), "studio_paused"),
        # 只要有一档还接单 → 说明栏显示可预约，不能和卡片上的删除线自相矛盾
        (("是", "是"), "studio_bookable"),
        (("是", "否"), "studio_bookable"),
        # 留空同样算接单
        (("", ""), "studio_bookable"),
    ],
)
def test_studio_note_row_follows_the_bookable_column(services_dir, studio, expected):
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格,是否接单\n"
        f"棚拍,单人,100,{studio[0]}\n棚拍,双人,150,{studio[1]}\n"
        "外景,单人,120,是\n外景,双人,180,是\n",
    )

    pricing = load_pricing()

    assert pricing["outdoor_note"] == {
        "title_key": "extra_studio",
        "value_key": expected,
    }


def test_studio_note_row_is_rendered(services_dir):
    """说明栏那一行必须由模板渲染出来；棚拍全不接时显示暂停文案。"""
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,20\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格,是否接单\n"
        "棚拍,单人,100,否\n棚拍,双人,150,否\n外景,单人,120,是\n外景,双人,180,是\n",
    )

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")

    assert 'data-i18n="extra_studio"' in html
    assert 'data-i18n="studio_paused"' in html
    assert 'data-i18n="studio_bookable"' not in html


def test_invalid_bookable_value_fails_the_build(services_dir):
    _write(services_dir, CONVENTION_CSV, "张数,价格,是否接单\n1,20,maybe\n3,55,是\n6,100,是\n9,150,是\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格,是否接单\n棚拍,单人,100,是\n棚拍,双人,150,是\n外景,单人,120,是\n外景,双人,180,是\n",
    )

    with pytest.raises(RuntimeError) as excinfo:
        load_pricing()

    assert "是否接单" in str(excinfo.value) and "无法识别" in str(excinfo.value)


@pytest.mark.parametrize(
    "convention,outdoor,message",
    [
        ("张数,价格\n1,20\n3,55\n6,100\n9,150\n", "类型,人数,价格\n棚拍,单人,100\n", "缺少档位"),
        ("张数\n1\n3\n6\n9\n", None, "缺少列"),
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

    assert "无法读取价目表" in str(excinfo.value)


def test_services_page_renders_csv_prices(services_dir):
    """模板里的价格必须来自 CSV，而不是写死的常量。"""
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,30\n3,60\n6,110\n9,160\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格,是否接单\n"
        "棚拍,单人,110,否\n棚拍,双人,160,否\n外景,单人,130,是\n外景,双人,190,\n",
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
    ["N/A", "n/a", "NA", " N/A ", "待定", "", "1OO", "0", "-5", "12.5"],
)
def test_non_positive_integer_price_renders_dash(services_dir, literal):
    """价格没有白名单：解析不出正整数（N/A / 留空 / 写错 / 0 / 负数）→ no_price，构建照常通过。"""
    _write(
        services_dir,
        CONVENTION_CSV,
        f"张数,价格\n1,{literal}\n3,55\n6,100\n9,150\n",
    )
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格\n"
        f"棚拍,单人,{literal}\n棚拍,双人,150\n外景,单人,120\n外景,双人,180\n",
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
    _write(services_dir, CONVENTION_CSV, "张数,价格\n1,N/A\n3,55\n6,100\n9,150\n")
    _write(
        services_dir,
        OUTDOOR_CSV,
        "类型,人数,价格\n棚拍,单人,待定\n棚拍,双人,150\n外景,单人,120\n外景,双人,0\n",
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
    assert "待定" not in html
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

    assert pricing["convention"], "convention.csv 至少要有一档"
    assert len(pricing["outdoor"]) == 4
    # 张数升序且不重复
    shots = [plan["shots"] for plan in pricing["convention"]]
    assert shots == sorted(shots) and len(set(shots)) == len(shots)

    html = build.render_page(RENDER_APP, "services.html", "/services", "zh-cn")
    # 每个档位都必须渲染出一个价格格（数字或 '-'），数量跟 CSV 对齐
    assert html.count('<span class="price-num">') == len(pricing["convention"]) + 4
    assert "None" not in html
