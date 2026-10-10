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

"""作品集（portfolio）图片清单：从 ``src/static/portfolio`` 动态扫描。

首页作品区与 images.limooo.cn 门面页都按这里的清单排版：往
``src/static/portfolio`` 里增删图片后重新构建，卡片数量与排版会自动
跟着变，模板里不再维护任何图片文件名。

模板上下文（``portfolio_items``）每项字段：
    name       —— 源图文件名（含扩展名，jpg/png/webp 原样保留）
    stem       —— 去掉扩展名的文件名（缩略图固定用 .webp/.avif，按 stem 取）
    ext        —— 小写扩展名
    num        —— 两位序号（01、02…），用于 alt 文案编号
    width      —— 源图像素宽（缺 Pillow / 缺源图时为 None）
    height     —— 源图像素高（同上）
    ratio      —— CSS aspect-ratio 值（如 "3 / 4"），未知时回退 3 / 4
    orientation—— "portrait" / "landscape" / "square"，卡片按此选版式
"""

from __future__ import annotations

import os
import re
from math import gcd

from config import STATIC_DIR

#: 源图缺失/尺寸读不到时的兜底清单（顺序与手写模板时代保持一致）。
#: CI 干净 checkout 里 ``src/static/portfolio/`` 被 .gitignore 排除，
#: 此时仍渲染出完整卡片结构，避免首页空掉、构建产物每次都不一样。
FALLBACK_PORTFOLIO_IMAGES = (
    "IMG_0203.webp",
    "IMG_0146.webp",
    "IMG_0130.webp",
    "IMG_0244.webp",
    "IMG_0115.webp",
    "IMG_0179.webp",
)

#: 读不到原始尺寸时假定的画幅（历史默认，全部按 3:4 竖幅渲染）。
DEFAULT_RATIO = (3, 4)

_PORTFOLIO_EXTS = re.compile(r"\.(png|jpe?g|webp)$", re.I)


def portfolio_source_dir() -> str:
    """作品集源图目录（本机私有，不入库）。"""
    return os.path.join(STATIC_DIR, "portfolio")


def list_portfolio_images(source_dir: str | None = None) -> list[str]:
    """按文件名排序返回作品集图片名（含扩展名）；目录缺失或为空时返回 []。"""
    source_dir = source_dir or portfolio_source_dir()
    if not os.path.isdir(source_dir):
        return []
    return sorted(
        name
        for name in os.listdir(source_dir)
        if _PORTFOLIO_EXTS.search(name) and not name.startswith(".")
    )


def image_ratio(path: str) -> tuple[int, int] | None:
    """读取图片的宽高比（约分后的整数对）；缺 Pillow 或读不到时返回 None。

    约分后比例保持精确（1080×1440 → 3:4，1350×900 → 3:2），模板写出的
    ``aspect-ratio`` 不带小数，卡片框与图片实际画幅完全一致。
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None
    divisor = gcd(width, height)
    return width // divisor, height // divisor


def portfolio_items(source_dir: str | None = None) -> list[dict[str, object]]:
    """模板上下文：作品集卡片清单；源图缺失时回退到兜底清单。"""
    source_dir = source_dir or portfolio_source_dir()
    names = list_portfolio_images(source_dir)
    if not names:
        names = list(FALLBACK_PORTFOLIO_IMAGES)

    items: list[dict[str, object]] = []
    for index, name in enumerate(names, start=1):
        stem, ext = os.path.splitext(name)
        # 兜底清单在干净 checkout 里没有源文件，读不到就按默认 3:4 排版
        ratio = image_ratio(os.path.join(source_dir, name)) or DEFAULT_RATIO
        width, height = ratio
        if height > width:
            orientation = "portrait"
        elif width > height:
            orientation = "landscape"
        else:
            orientation = "square"
        items.append(
            {
                "name": name,
                "stem": stem,
                "ext": ext.lstrip(".").lower(),
                "num": f"{index:02d}",
                "width": width,
                "height": height,
                "ratio": f"{width} / {height}",
                "orientation": orientation,
            }
        )
    return items
