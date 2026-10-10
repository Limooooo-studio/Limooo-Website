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

"""Limooo 构建期只读渲染应用。

构建静态页面时不需要启动 Flask 业务应用，也不需要读取生产密钥、创建
SQLite 数据库或初始化路由。这里提供一个最小 Flask 应用，只注册模板所需
的 i18n 上下文，供 ``src/build.py`` 预渲染使用。
"""

from __future__ import annotations

import functools

from flask import Flask, g

# 契约常量同理：语言列表 / cookie 名与 TTL / 根域名都要**在调用时**从 config
# 模块现读。import 时绑定会让 monkeypatch 了 config.SUPPORTED_LANGS 的测试拿到
# 旧列表，lru_cache 更会把旧结果钉死——渲染用例假绿、加语言不生效（W1-3 的
# 「加语言只改契约一处」正是靠这条成立）。
import config

# SERVICES_DIR 必须**在调用时**从模块读，不能在 import 时绑定成常量：
# 构建期缓存把它当 cache key，而测试会 monkeypatch services_pricing.SERVICES_DIR
# 指向临时 CSV 目录。import 时绑定会让缓存永远只认仓库里那份，测试静默假绿
# （2026-10-11 实测：全量 pytest 下渲染用例拿到真 CSV 的价格）。
import services_pricing
from config import (
    DEFAULT_LANG,
    KEY_FALLBACK_LANG,
    STATIC_DIR,
    TEMPLATES_DIR,
    load_translations,
)
from portfolio import portfolio_items, portfolio_source_dir
from services_pricing import load_pricing


@functools.cache
def _cached_portfolio_items(source_dir: str) -> list[dict[str, object]]:
    """作品集卡片清单：一次构建里 ``src/static/portfolio`` 不会变，只扫描一次。

    ``portfolio_items()`` 会为每张源图 ``PIL.Image.open`` 读尺寸，而
    ``context_processor`` 每个页面都会取一次上下文，缓存前一次构建要调用
    33 次（4 语言 × 8 页 + 门禁页）。构建产物必须逐字节一致，所以这里只
    做记忆化，不改 ``portfolio.portfolio_items`` 的返回内容。

    源目录是**显式参数**（由调用方现读 ``portfolio_source_dir()``）而不是闭包里的
    模块常量：同一个进程里换过 ``STATIC_DIR`` / ``SERVICES_DIR`` 的测试必须自然
    失配，否则会静默读到上一轮测试的临时目录（缓存串味）。
    """
    return portfolio_items(source_dir)


@functools.cache
def _cached_pricing(services_dir: str) -> dict[str, object]:
    """价目表：``docs/services/*.csv`` 每个 (目录) 只读一次（原先每次渲染都读）。

    参数化理由同上：``services_dir`` 进 cache key，换目录即重新读。
    """
    return load_pricing(services_dir)


def _lang_flag(code: str) -> str:
    """语言码的地区子标签 → 国旗 emoji（zh-cn → 🇨🇳）；没有地区段时返回空串。

    语言码全部来自契约 supported_langs，这里不写任何语言码字面量：新增一门
    语言只改契约，浮层自动多一项（文案键取主语言子标签，即 lang_<primary>）。
    """
    parts = code.split("-")
    if len(parts) < 2 or len(parts[1]) != 2 or not parts[1].isalpha():
        return ""
    region = parts[1].upper()
    return "".join(chr(0x1F1E6 + ord(ch) - ord("A")) for ch in region)


@functools.cache
def _cached_lang_options(supported_langs: tuple[str, ...]) -> list[dict[str, str]]:
    """语言浮层数据源：契约的 supported_langs 决定条目，模板只负责渲染。

    ``supported_langs`` 是**显式参数**（调用方现读 ``config.SUPPORTED_LANGS``）：
    它既是数据源也是 cache key，换契约或换测试的 monkeypatch 都自然重新计算，
    不会出现「改了语言列表、渲染却拿到缓存里的旧列表」这种假绿（与
    ``_cached_pricing(services_dir)`` / ``_cached_portfolio_items(source_dir)``
    同一模式）。
    """
    return [
        {
            "code": code,
            "flag": _lang_flag(code),
            "label_key": f"lang_{code.split('-')[0]}",
        }
        for code in supported_langs
    ]


def create_render_app() -> Flask:
    """创建只包含模板与 i18n 上下文的 Flask 应用。"""
    app = Flask(
        __name__,
        template_folder=str(TEMPLATES_DIR),
        static_folder=str(STATIC_DIR),
    )
    translations = load_translations()

    def translate(key: str, **kwargs: object) -> str:
        lang = getattr(g, "lang", DEFAULT_LANG)
        value = translations.get(lang, {}).get(
            key,
            translations.get(KEY_FALLBACK_LANG, {}).get(key, key),
        )
        if kwargs:
            try:
                return str(value).format(**kwargs)
            except (KeyError, IndexError, ValueError):
                return value
        return value

    @app.context_processor
    def inject_i18n() -> dict[str, object]:
        # 每次渲染现读契约（config 模块属性），不消费 import 时绑定的副本：
        # 测试 monkeypatch config.* 之后必须立刻生效。
        contract_langs = tuple(config.SUPPORTED_LANGS)
        lang = getattr(g, "lang", config.DEFAULT_LANG)
        return {
            "_": translate,
            "translations": translations.get(lang, {}),
            "gate_url": f"https://{config.GATE_HOST}/__gate",
            "image_asset_base": config.IMAGE_ASSET_BASE_URL,
            "image_watermark_base": config.IMAGE_WATERMARK_BASE_URL,
            "source_url": config.SOURCE_REPO_URL,
            # 前端只读的事实：语言列表 / cookie 名与 TTL / 根域名全部来自契约，
            # 由 _lang_attrs.html 注入到 <body data-*>，JS 不再写死（W1-3）。
            "root_domain": config.ROOT_DOMAIN,
            "default_lang": config.DEFAULT_LANG,
            "supported_langs": list(contract_langs),
            "lang_cookie": config.LANG_COOKIE,
            "lang_cookie_max_age": config.LANG_COOKIE_MAX_AGE,
            "theme_cookie": config.THEME_COOKIE,
            "theme_cookie_max_age": config.THEME_COOKIE_MAX_AGE,
            "lang_options": _cached_lang_options(contract_langs),
            # 作品区卡片：数量由 src/static/portfolio 里的图片决定
            # （portfolio_source_dir() 现读 portfolio.STATIC_DIR，缓存键随之变化）
            "portfolio_items": _cached_portfolio_items(portfolio_source_dir()),
            # 价目表：来自 docs/services/*.csv（改价不用动模板）
            "pricing": _cached_pricing(services_pricing.SERVICES_DIR),
        }

    return app


RENDER_APP = create_render_app()
