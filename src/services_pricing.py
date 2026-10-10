# Limooo - 统一配置与公共工具
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

"""services.limooo.cn 价目表的 CSV 数据源。

价目表不再写死在 templates/services.html 里，而是每次构建时从
``site/docs/services/*.csv`` 读取，改价只需改 CSV 再部署。
注意 ``site/docs/`` 是**按子域分目录**的容器：``docs/`` 归 docs.limooo.cn
（VitePress 内容源），``services/`` 归 services.limooo.cn（本模块读的价目表）：

  convention.csv   张数,价格[,是否接单]        → 场照拍摄（01）张数价
  outdoor.csv      类型,人数,价格[,是否接单]   → 正片拍摄（02）棚拍/外景 × 单人/双人

对应的说明文案（单位后缀、档位标签、注意事项）仍然走 locales/*.json，
只有「数字」「档位组合」与「是否接单」来自 CSV。CSV 缺失、表头不对、
档位无法识别/重复、是否接单取值非法时构建直接失败——价目表出错比构建失败严重得多。

价格列只有两种结果：**正整数**，或 **None**（渲染成 ``-``）。凡是解析不出正整数的
一律当作「价格暂不公开」——留空、``N/A``、``待定``、写错的数字、``0``、负数都一样；
卡片保留 ``CNY`` 前缀与单位后缀，只把数字换成 ``-``（``CNY - / 张``），
版式与其他档位完全一致。``-`` 不是 0，也不是免费。

用法：
    from services_pricing import load_pricing
    pricing = load_pricing()      # {"convention": [...], "outdoor": [...], "outdoor_note": {...}}
"""

from __future__ import annotations

import csv
import os

from config import BASE_DIR

SERVICES_DIR = os.path.join(BASE_DIR, "docs", "services")
# ↑ site/docs/ 现已按子域分目录：docs/ 归 docs.limooo.cn（VitePress 内容源，
#   由 ops/docs_deploy.sh 构建），services/ 归 services.limooo.cn（本模块读的价目表）。

CONVENTION_CSV = "convention.csv"
OUTDOOR_CSV = "outdoor.csv"

# 场照拍摄：CSV 的「张数」列 → 语料库里的单位后缀键。档位数由 CSV 决定，
# 这里没列到的档位（比如新增一档 4 张）照常渲染价格，只是不带单位后缀；
# 要给它加后缀就在这里补一条，并在 locales/*.json 加对应文案。
CONVENTION_UNIT_KEYS = {
    1: "unit_per_shot",
    3: "unit_per_3",
    6: "unit_per_6",
    9: "unit_per_9",
}

# 正片拍摄：（类型，人数）→ 语料库里的档位标签键
OUTDOOR_PLAN_KEYS = {
    ("棚拍", "单人"): "plan_studio_solo",
    ("棚拍", "双人"): "plan_studio_duo",
    ("外景", "单人"): "plan_outdoor_solo",
    ("外景", "双人"): "plan_outdoor_duo",
}

# 正片拍摄的四张卡片按这个顺序渲染，保证 CSV 行序变化不会打乱版式。
OUTDOOR_ORDER = (
    ("棚拍", "单人"),
    ("棚拍", "双人"),
    ("外景", "单人"),
    ("外景", "双人"),
)

# 可选的「是否接单」列：空或「是」= 接单，其他值必须是「否」。
BOOKABLE_COLUMN = "是否接单"
BOOKABLE_YES = {"", "是", "y", "yes", "true", "1"}
BOOKABLE_NO = {"否", "n", "no", "false", "0"}

# 「价格」列没有白名单：解析不出正整数就是「暂不公开」，模板渲染成「-」。
# 「说明」栏里按类型汇总的那一行：CSV 的类型列 → （说明栏标题键，暂停文案键）
NOTE_ROW_KEYS = {
    "棚拍": ("extra_studio", "studio_paused"),
}


def _read_rows(filename: str) -> list[dict[str, str]]:
    """读取单个 CSV，去掉表头与空行。"""
    path = os.path.join(SERVICES_DIR, filename)
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            rows = [
                {(k or "").strip(): (v or "").strip() for k, v in row.items()}
                for row in csv.DictReader(f)
                if any((v or "").strip() for v in row.values())
            ]
    except OSError as exc:
        raise RuntimeError(f"无法读取价目表 {path}: {exc}") from exc
    if not rows:
        raise RuntimeError(f"价目表为空: {path}")
    return rows


def _parse_price(raw: str) -> int | None:
    """价格列 → 正整数；解析不出正整数的一律 → None。

    没有白名单：留空、``N/A``、``待定``、写错的数字、``0``、负数都是 None，
    模板据此把数字渲染成「-」。None 不是 0，也不是免费。
    """
    text = raw.strip()
    try:
        price = int(text)
    except ValueError:
        return None
    return price if price > 0 else None


def _parse_bookable(filename: str, lineno: int, row: dict[str, str]) -> bool:
    """读可选的「是否接单」列 → 是否接单（缺列或留空都算接单）。"""
    raw = row.get(BOOKABLE_COLUMN, "").strip().lower()
    if raw in BOOKABLE_YES:
        return True
    if raw in BOOKABLE_NO:
        return False
    raise RuntimeError(
        f"{filename} 第 {lineno} 行{BOOKABLE_COLUMN}列取值无法识别: {raw!r}"
        f"（应为「是」/「否」，留空视为「是」）"
    )


def load_convention() -> list[dict[str, object]]:
    """场照拍摄价目：按张数升序，返回 [{shots, price, unit_key, bookable}, ...]。"""
    filename = CONVENTION_CSV
    rows = _read_rows(filename)
    missing = {"张数", "价格"} - set(rows[0])
    if missing:
        raise RuntimeError(f"{filename} 缺少列: {', '.join(sorted(missing))}")

    plans: list[dict[str, object]] = []
    seen: set[int] = set()
    for index, row in enumerate(rows, start=2):
        shots_raw = row["张数"]
        try:
            shots = int(shots_raw)
        except ValueError as exc:
            raise RuntimeError(
                f"{filename} 第 {index} 行张数不是整数: {shots_raw!r}"
            ) from exc
        if shots <= 0:
            raise RuntimeError(f"{filename} 第 {index} 行张数必须为正数: {shots_raw!r}")
        if shots in seen:
            raise RuntimeError(f"{filename} 第 {index} 行张数重复: {shots}")
        seen.add(shots)
        bookable = _parse_bookable(filename, index, row)
        price = _parse_price(row["价格"])
        plans.append(
            {
                "shots": shots,
                "price": price,
                # 没有价格 → 模板把数字渲染成「-」（CNY 前缀与单位后缀保留）
                "no_price": price is None,
                "unit_key": CONVENTION_UNIT_KEYS.get(shots),
                "bookable": bookable,
                "strikethrough": not bookable,
            }
        )

    # 档位数量与张数完全由 CSV 决定（加一档不用改代码），只按张数升序排列，
    # 保证 plan-grid 的视觉顺序稳定。
    plans.sort(key=lambda item: int(item["shots"]))
    return plans


def load_outdoor() -> dict[tuple[str, str], dict[str, object]]:
    """正片拍摄价目：{(类型, 人数): {price, bookable}}。"""
    filename = OUTDOOR_CSV
    rows = _read_rows(filename)
    missing = {"类型", "人数", "价格"} - set(rows[0])
    if missing:
        raise RuntimeError(f"{filename} 缺少列: {', '.join(sorted(missing))}")

    plans: dict[tuple[str, str], dict[str, object]] = {}
    for index, row in enumerate(rows, start=2):
        key = (row["类型"], row["人数"])
        if key not in OUTDOOR_PLAN_KEYS:
            raise RuntimeError(
                f"{filename} 第 {index} 行档位无法识别: {key[0]}/{key[1]}"
            )
        if key in plans:
            raise RuntimeError(f"{filename} 第 {index} 行档位重复: {key[0]}/{key[1]}")
        price = _parse_price(row["价格"])
        plans[key] = {
            "price": price,
            "no_price": price is None,
            "bookable": _parse_bookable(filename, index, row),
        }

    absent = [key for key in OUTDOOR_ORDER if key not in plans]
    if absent:
        listed = ", ".join(f"{a}/{b}" for a, b in absent)
        raise RuntimeError(f"{filename} 缺少档位: {listed}")
    return plans


def outdoor_note_row(plans: dict[tuple[str, str], dict[str, object]]) -> dict[str, str]:
    """「说明」栏里按类型汇总的那一行（棚拍）。

    整类都「是否接单=否」时用暂停文案（「暂时不接」）；只要有一档还接单就显示
    「可预约」——说明栏和卡片上的删除线永远说同一件事，不会出现「卡片划掉了、
    说明栏却还写着能约」的矛盾。
    """
    title_key, paused_key = NOTE_ROW_KEYS["棚拍"]
    bookable = any(plans[key]["bookable"] for key in OUTDOOR_ORDER if key[0] == "棚拍")
    return {
        "title_key": title_key,
        "value_key": "studio_bookable" if bookable else paused_key,
    }


def load_pricing() -> dict[str, object]:
    """读取两份 CSV，返回渲染 services.html 所需的价目表结构。"""
    convention = load_convention()
    outdoor_plans = load_outdoor()
    outdoor = [
        {
            "plan_key": OUTDOOR_PLAN_KEYS[key],
            "price": outdoor_plans[key]["price"],
            "no_price": outdoor_plans[key]["no_price"],
            # 「是否接单」为「否」的档位加删除线（来自 CSV，不再写死）
            "strikethrough": not outdoor_plans[key]["bookable"],
        }
        for key in OUTDOOR_ORDER
    ]
    return {
        "convention": convention,
        "outdoor": outdoor,
        "outdoor_note": outdoor_note_row(outdoor_plans),
    }
