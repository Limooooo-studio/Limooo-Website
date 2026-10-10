"""构建脚本纯函数测试（不写 public/ 产物）。"""

import json
import re
from pathlib import Path

import build
from render_app import RENDER_APP


def test_preview_i18n_patch_contains_all_languages():
    patch = build.preview_i18n_patch()
    assert "zh-cn" in patch
    assert "en-us" in patch
    assert "ja-jp" in patch
    assert "ko-kr" in patch
    assert "window.__PREVIEW_I18N__" in patch


def test_render_page_switches_language():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    assert '<html lang="zh-cn">' in html
    assert "/static/" in html
    html_en = build.render_page(RENDER_APP, "index.html", "/", "en-us")
    assert '<html lang="en-us">' in html_en


def test_body_translation_dict_does_not_collide_with_i18n_markers():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    body_start = html.index("<body")
    body_open = html[body_start:html.index(">", body_start) + 1]

    assert "data-i18n-dict='" in body_open
    assert "data-i18n='" not in body_open

    base_js = Path(build.BASE_DIR) / "src/static/js/base.js"
    assert "getAttribute('data-i18n-dict')" in base_js.read_text(encoding="utf-8")


def test_home_image_urls_use_edge_cached_asset_host():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    assert "https://images.limooo.cn/static/portfolio/thumbs/" in html
    assert "https://image.limooo.cn/portfolio/thumbs/" not in html


def test_contact_prerenders_all_qr_images():
    html = build.render_page(RENDER_APP, "contact.html", "/contact", "zh-cn")
    preloads = re.findall(
        r'<link rel="preload" as="image" type="image/webp"[^>]*href="([^"]+)"',
        html,
    )

    assert len(preloads) == 5
    assert set(preloads) == {
        "https://image.limooo.cn/qr-codes/bilibili.webp",
        "https://image.limooo.cn/qr-codes/qq.webp",
        "https://image.limooo.cn/qr-codes/wechat.webp",
        "https://image.limooo.cn/qr-codes/mail-services-zh-cn.webp",
        "https://image.limooo.cn/qr-codes/form-services-zh-cn.webp",
    }
    assert html.count('(hover: hover) and (pointer: fine)') == 5


def test_contact_survey_block_uses_limooo_shortlink_and_qr():
    """问卷块：href 指向 limooo.cn 短链、data-qr 指向本语言二维码，四种语言一致。"""
    for lang in ("zh-cn", "en-us", "ja-jp", "ko-kr"):
        html = build.render_page(RENDER_APP, "contact.html", "/contact", lang)
        block = html[html.index('id="surveyBlock"'):]
        block = block[:block.index("</a>")]

        assert 'href="https://limooo.cn/link/photograph-form-%s"' % lang in block
        assert 'data-qr="https://image.limooo.cn/qr-codes/form-services-%s.webp"' % lang in block
        assert "qr-trigger" in block
        assert "lime-official.feishu.cn" not in block


def test_theme_challenge_uses_gate_url_and_skips_gate_page():
    html = build.render_page(RENDER_APP, "index.html", "/", "zh-cn")
    assert 'data-gate-url="https://auth.limooo.cn/__gate"' in html
    gate_html = build.render_gate(RENDER_APP, "zh-cn")
    assert 'data-gate-url=' not in gate_html


def test_visitor_inherits_base_nav_logo():
    html = build.render_page(RENDER_APP, "visitor.html", "/visitor", "zh-cn")
    logo_start = html.index('id="nav-logo"')
    logo_open_end = html.index(">", logo_start) + 1

    assert "Limooo" in html[logo_start:html.index("</a>", logo_open_end)]
    assert 'href="https://limooo.cn"' in html[html.rindex("<a", 0, logo_start):logo_open_end]


def test_static_ignore_skips_parallel_artifacts():
    ignored = build._static_ignore("/tmp/static", [
        "visitor.js",
        "visitor 2.js",
        "visitors 3.ts",
        ".DS_Store",
        "legacy.bak",
        "normal.css",
    ])
    assert ignored == {
        "visitor 2.js",
        "visitors 3.ts",
        ".DS_Store",
        "legacy.bak",
        "__pycache__",
    }


def test_pages_edge_config_excludes_static_assets(tmp_path):
    build.write_pages_edge_config(str(tmp_path))

    routes = json.loads((tmp_path / "_routes.json").read_text(encoding="utf-8"))
    assert routes["version"] == 1
    assert "/static/*" in routes["exclude"]
    assert "/favicon.svg" in routes["exclude"]

    headers = (tmp_path / "_headers").read_text(encoding="utf-8")
    assert "Cache-Control: public, max-age=86400" in headers
    assert "Cache-Control: public, max-age=31536000, immutable" in headers
    assert "stale-while-revalidate=86400" in headers


def test_remove_bad_artifacts(tmp_path):
    root = tmp_path / "static"
    root.mkdir()
    (root / ".DS_Store").write_bytes(b"")
    (root / "visitor 2.js").write_text("old", encoding="utf-8")
    (root / "visitor.js").write_text("new", encoding="utf-8")

    build._remove_bad_artifacts(str(root))

    assert not (root / ".DS_Store").exists()
    assert not (root / "visitor 2.js").exists()
    assert (root / "visitor.js").read_text(encoding="utf-8") == "new"


# ── W1 · 契约未生效 ────────────────────────────────────────────────────────


def test_html_lang_is_rendered_by_the_template_for_every_language():
    """W1-4：<html lang> 直接由模板渲染，四语都正确（不再靠字符串替换）。"""
    for lang in build.LANGS:
        html = build.render_page(RENDER_APP, "index.html", "/", lang)
        assert '<html lang="%s">' % lang in html
        assert 'data-lang="%s"' % lang in html

        gate = build.render_gate(RENDER_APP, lang)
        assert '<html lang="%s">' % lang in gate
        assert 'data-lang="%s"' % lang in gate

    # 模板里不允许再写死 zh-cn（契约 default_lang 是 en-us）
    for name in ("base.html", "auth.html", "redirect.html", "preview.html"):
        source = (Path(build.BASE_DIR) / "src/templates" / name).read_text(encoding="utf-8")
        assert '<html lang="zh-cn">' not in source, name
        assert '<html lang="{{ g.lang }}">' in source, name

    # 构建脚本不再做 <html lang> 字符串替换
    build_py = (Path(build.BASE_DIR) / "src/build.py").read_text(encoding="utf-8")
    assert '<html lang=\\"zh-cn\\">' not in build_py


def test_require_locale_keys_fails_loudly_on_missing_key(monkeypatch):
    """W1-2：跳转页文案缺键必须 RuntimeError，不能静默回退中文。"""
    complete = build.load_translations()
    broken = {lang: dict(data) for lang, data in complete.items()}
    del broken["en-us"]["redirect_title"]
    monkeypatch.setattr(build, "load_translations", lambda: broken)

    try:
        build._require_locale_keys("en-us", build.REDIRECT_I18N_KEYS)
    except RuntimeError as exc:
        assert "redirect_title" in str(exc)
        assert "en-us.json" in str(exc)
    else:  # pragma: no cover - 只有契约破损时才会走到
        raise AssertionError("missing redirect_title must raise RuntimeError")


def test_require_locale_keys_accepts_complete_locales():
    for lang in build.LANGS:
        redirect = build._require_locale_keys(lang, build.REDIRECT_I18N_KEYS)
        assert redirect["title"] and redirect["text"]
        assert redirect["footer_rights"] and redirect["footer_source"]
        assert redirect["footer_source_link"]
        gate = build._require_locale_keys(lang, build.GATE_I18N_KEYS)
        assert gate["title"] and gate["footer_rights"]


def test_write_runtime_functions_refuses_to_fall_back_to_chinese(tmp_path, monkeypatch):
    """W1-2：write_runtime_functions 缺键即失败，不产出带中文兜底的 runtime.ts。"""
    complete = build.load_translations()
    broken = {lang: dict(data) for lang, data in complete.items()}
    del broken["ja-jp"]["footer_source_link"]
    monkeypatch.setattr(build, "load_translations", lambda: broken)
    monkeypatch.setattr(build, "FUNCTIONS_DIR", str(tmp_path))

    try:
        build.write_runtime_functions()
    except RuntimeError as exc:
        assert "footer_source_link" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("missing footer_source_link must raise RuntimeError")
    assert not (tmp_path / "_data" / "runtime.ts").exists()


def test_validate_locale_completeness_catches_html_footer_drift():
    """W1-2：_footer.html 走的 _() 会回退中文，所以缺键必须构建失败。"""
    complete = build.load_translations()
    broken = {lang: dict(data) for lang, data in complete.items()}
    del broken["ko-kr"]["footer_rights"]
    try:
        build.validate_locale_completeness(broken)
    except RuntimeError as exc:
        assert "ko-kr.json" in str(exc)
        assert "footer_rights" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("missing footer_rights must raise RuntimeError")

    # 当前仓库的四个 locale 必须完整（否则构建会失败）
    build.validate_locale_completeness(complete)


def test_frontend_reads_contract_facts_from_data_attributes():
    """W1-3：语言列表 / cookie 名与 TTL / 根域名由构建注入，JS 只读。"""
    html = build.render_page(RENDER_APP, "index.html", "/", "en-us")
    body_open = html[html.index("<body"):html.index(">", html.index("<body")) + 1]

    assert 'data-supported-langs="%s"' % " ".join(build.LANGS) in body_open
    assert 'data-root-domain="%s"' % build.ROOT_DOMAIN in body_open
    assert 'data-lang-cookie="user_lang_preference"' in body_open
    assert 'data-theme-cookie="limooo_theme"' in body_open
    assert 'data-lang-cookie-max-age="31536000"' in body_open
    assert 'data-theme-cookie-max-age="31536000"' in body_open
    assert 'data-default-lang="en-us"' in body_open

    # 门禁页（auth.html，不继承 base.html）也要有同一批属性
    gate = build.render_gate(RENDER_APP, "en-us")
    gate_body = gate[gate.index("<body"):gate.index(">", gate.index("<body")) + 1]
    assert 'data-supported-langs="%s"' % " ".join(build.LANGS) in gate_body
    assert 'data-lang-cookie="user_lang_preference"' in gate_body

    # 语言浮层条目由契约生成：条目数 == supported_langs 数，且每门语言一项
    for lang in build.LANGS:
        page = build.render_page(RENDER_APP, "index.html", "/", lang)
        menu = page[page.index('id="langMenu"'):page.index("</nav>")]
        assert menu.count('data-action="setLang"') == len(build.LANGS)
        for code in build.LANGS:
            assert 'data-lang="%s"' % code in menu
        assert 'class="theme-option selected" data-lang="%s"' % lang in menu

    # 门禁页浮层同样由契约生成
    gate_menu = gate[gate.index('id="langMenu"'):]
    assert gate_menu.count('data-action="setLang"') == len(build.LANGS)


def test_frontend_js_has_no_hardcoded_language_list_or_cookie_ttl():
    """W1-3：JS 只能读 data-*，不能再写死语言数组 / cookie 名 / TTL。"""
    js_dir = Path(build.BASE_DIR) / "src/static/js"
    base_js = (js_dir / "base.js").read_text(encoding="utf-8")
    auth_js = (js_dir / "auth.js").read_text(encoding="utf-8")

    for source, name in ((base_js, "base.js"), (auth_js, "auth.js")):
        assert "data-default-lang" in source, name
        assert "data-lang-cookie" in source, name
        assert "data-theme-cookie" in source, name
        assert "data-root-domain" in source, name
        assert "['zh-cn', 'en-us', 'ja-jp', 'ko-kr']" not in source, name
        assert "max-age=31536000; SameSite=Lax" not in source, name
        assert "'user_lang_preference='" not in source, name
        assert "'limooo_theme='" not in source, name
    # 语言列表（后台预取用）只有 base.js 需要，同样来自 data-*
    assert "data-supported-langs" in base_js


def test_preview_localization_uses_contract_domains(monkeypatch):
    """W1-5：预览改写用契约常量构造，改域名会跟随（不是写死 limooo.cn）。"""
    patterns = build.preview_localization_patterns()
    sample = (
        '<img src="https://limooo.cn/static/icons/Limooo.svg">'
        '<img src="https://images.limooo.cn/static/icons/Limooo.svg">'
        '<img src="https://image.limooo.cn/portfolio/IMG_0115.webp">'
        '<a href="https://services.limooo.cn/services">x</a>'
        '<a href="https://limooo.cn/services">y</a>'
    )
    localized = patterns["asset"].sub(r'\1="../static/', sample)
    assert 'src="../static/icons/Limooo.svg"' in localized
    assert 'src="../static/portfolio/IMG_0115.webp"' in localized
    assert "https://" not in localized.split("<a")[0]

    pages = dict(build.preview_subdomain_pages())
    assert pages[build.SERVICES_HOST] == "services.html"
    assert pages[build.CONTACT_HOST] == "contact.html"
    assert pages[build.APPLE_ACCOUNT_HOST] == "apple-account.html"
    for host in pages:
        assert host.endswith("." + build.ROOT_DOMAIN)

    # 换掉契约里的根域名后，同一段 HTML 不再被旧域名的规则改写
    monkeypatch.setattr(build, "ROOT_DOMAIN", "example.com")
    monkeypatch.setattr(build, "SERVICES_HOST", "services.example.com")
    monkeypatch.setattr(build, "IMAGE_ASSET_HOST", "images.example.com")
    monkeypatch.setattr(build, "IMAGE_WATERMARK_HOST", "image.example.com")
    swapped = build.preview_localization_patterns()
    assert swapped["asset"].sub(r'\1="../static/', sample) == sample
    assert dict(build.preview_subdomain_pages())[build.SERVICES_HOST] == "services.html"
    assert swapped["root_href"].search('href="https://example.com/"')
    assert not swapped["root_href"].search('href="https://limooo.cn/"')


def test_lang_options_follow_the_contract_at_call_time(monkeypatch):
    """W1-3：语言列表在调用时现读契约，缓存按列表参数分桶（改了立刻生效）。

    回归点：`_cached_lang_options` 曾经是 maxsize=1 的无参缓存 + import 时绑定的
    `SUPPORTED_LANGS`，monkeypatch 契约后渲染仍拿旧列表（假绿）。
    """
    import config
    import render_app

    monkeypatch.setattr(config, "SUPPORTED_LANGS", ("aa-aa", "bb-bb"))
    html = build.render_page(render_app.RENDER_APP, "index.html", "/", "aa-aa")

    assert 'data-supported-langs="aa-aa bb-bb"' in html
    assert html.count('data-action="setLang"') == 2
    assert 'data-lang="aa-aa"' in html and 'data-lang="bb-bb"' in html
    # 旗帜由地区子标签推出，文案键取主语言子标签
    options = render_app._cached_lang_options(("aa-aa", "bb-bb"))
    assert [o["code"] for o in options] == ["aa-aa", "bb-bb"]
    assert [o["label_key"] for o in options] == ["lang_aa", "lang_bb"]
    assert options[0]["flag"]  # 🇦🇦 之类的区域指示符，非空即可

    # 换回契约原值时不会命中上一轮的缓存
    monkeypatch.undo()
    options = render_app._cached_lang_options(tuple(config.SUPPORTED_LANGS))
    assert [o["code"] for o in options] == list(build.LANGS)
