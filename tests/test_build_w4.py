"""docs/22 W4：构建期轻量化、产物瘦身与 A2（作品集原图不外发）的回归测试。

覆盖：
  W4-1 上下文处理器只算一次不变量（load_pricing / portfolio_items）
  W4-2 tailwind.input.css 不进部署包
  W4-5 manifest 内容必须与产物逐字节一致
  W4-6 缩略图不放大窄图
  W9-22 动 public/ 之前先校验图片前置条件、copytree 后立刻删原图
"""

from __future__ import annotations

import json
import re

import build
import portfolio
import pytest
import render_app
import services_pricing


# ── W4-1 构建期只算一次不变量 ────────────────────────────────────────


def test_context_processor_computes_invariants_once(tmp_path, monkeypatch):
    """上下文处理器每次渲染都取一次不变量，但同一份输入只应真算一次。

    原先 portfolio_items() / load_pricing() 写在 context_processor 里，一次构建
    被调用 33 次（4 语言 × 8 页 + 门禁页）；portfolio_items 每页还要
    PIL.Image.open 读一遍全部源图。现在两者各由一个 lru_cache 包装，且源目录
    进 cache key。
    """
    Image = pytest.importorskip("PIL.Image")

    static_dir = tmp_path / "static"
    services_dir = tmp_path / "services"
    (static_dir / "portfolio").mkdir(parents=True)
    services_dir.mkdir()
    Image.new("RGB", (1080, 1440), "red").save(static_dir / "portfolio" / "shot.webp", "WEBP")
    _seed_services(services_dir, 20)
    monkeypatch.setattr("portfolio.STATIC_DIR", str(static_dir))
    monkeypatch.setattr("services_pricing.SERVICES_DIR", str(services_dir))

    expected_items = portfolio.portfolio_items(str(static_dir / "portfolio"))
    expected_pricing = services_pricing.load_pricing(str(services_dir))

    for helper, arg, expected in (
        (render_app._cached_portfolio_items, str(static_dir / "portfolio"), expected_items),
        (render_app._cached_pricing, str(services_dir), expected_pricing),
    ):
        helper.cache_clear()
        assert helper.cache_info().misses == 0

        first = helper(arg)
        assert first == expected
        for _ in range(32):  # 再取 32 次，模拟其余 32 个页面
            assert helper(arg) == first

        info = helper.cache_info()
        assert info.misses == 1, f"{helper.__name__} 被真算了 {info.misses} 次"
        assert info.hits == 32
        helper.cache_clear()


def test_cached_helpers_match_the_originals():
    """缓存只是记忆化：返回值必须与未缓存的原始函数完全一致。"""
    render_app._cached_portfolio_items.cache_clear()
    render_app._cached_pricing.cache_clear()

    source = portfolio.portfolio_source_dir()
    assert render_app._cached_portfolio_items(source) == portfolio.portfolio_items(source)
    assert render_app._cached_pricing(services_pricing.SERVICES_DIR) == services_pricing.load_pricing()


def test_rendering_pages_does_not_grow_cache_misses():
    """渲染一批页面后，底层函数仍只算过一次（回归：别再退回每次现算）。"""
    render_app._cached_portfolio_items.cache_clear()
    render_app._cached_pricing.cache_clear()

    for lang in ("zh-cn", "en-us", "ja-jp", "ko-kr"):
        build.render_page(render_app.RENDER_APP, "index.html", "/", lang)
        build.render_page(render_app.RENDER_APP, "services.html", "/services", lang)

    assert render_app._cached_portfolio_items.cache_info().misses == 1
    assert render_app._cached_pricing.cache_info().misses == 1


def _seed_services(dir_path, solo_price):
    (dir_path / services_pricing.CONVENTION_CSV).write_text(
        f"shots,price\n1,{solo_price}\n3,55\n6,100\n9,150\n", encoding="utf-8"
    )
    (dir_path / services_pricing.OUTDOOR_CSV).write_text(
        "type,people,price\n"
        "studio,solo,100\nstudio,duo,150\noutdoor,solo,120\noutdoor,duo,180\n",
        encoding="utf-8",
    )


def test_two_services_dirs_do_not_cross_pollute(tmp_path, monkeypatch):
    """缓存必须在换目录时自然失配，不靠调用方 cache_clear()（W4-1 副作用回归）。

    之前的实现是无参 lru_cache(maxsize=1)，同一个 pytest 进程里第二个临时
    SERVICES_DIR 会拿到第一个目录的价目表——静默假绿。
    """
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    _seed_services(first, 111)
    _seed_services(second, 222)

    monkeypatch.setattr("services_pricing.SERVICES_DIR", str(first))
    html_first = build.render_page(render_app.RENDER_APP, "services.html", "/services", "zh-cn")

    monkeypatch.setattr("services_pricing.SERVICES_DIR", str(second))
    html_second = build.render_page(render_app.RENDER_APP, "services.html", "/services", "zh-cn")

    prices_first = re.findall(r'<span class="price-num">CNY (\d+)', html_first)
    prices_second = re.findall(r'<span class="price-num">CNY (\d+)', html_second)
    assert prices_first[0] == "111", prices_first
    assert prices_second[0] == "222", prices_second


def test_two_portfolio_dirs_do_not_cross_pollute(tmp_path, monkeypatch):
    """作品集缓存同理：换 STATIC_DIR 后必须重新扫描，不能复用上一轮清单。"""
    Image = pytest.importorskip("PIL.Image")

    first = tmp_path / "first"
    second = tmp_path / "second"
    (first / "portfolio").mkdir(parents=True)
    (second / "portfolio").mkdir(parents=True)
    Image.new("RGB", (1080, 1440), "red").save(first / "portfolio" / "alpha.webp", "WEBP")
    Image.new("RGB", (1080, 1440), "red").save(second / "portfolio" / "beta.webp", "WEBP")

    monkeypatch.setattr("portfolio.STATIC_DIR", str(first))
    html_first = build.render_page(render_app.RENDER_APP, "index.html", "/", "zh-cn")
    assert "alpha-640.webp" in html_first
    assert "beta-640.webp" not in html_first

    monkeypatch.setattr("portfolio.STATIC_DIR", str(second))
    html_second = build.render_page(render_app.RENDER_APP, "index.html", "/", "zh-cn")
    assert "beta-640.webp" in html_second
    assert "alpha-640.webp" not in html_second


# ── W4-2 部署包里不该有构建输入 ──────────────────────────────────────


def test_static_ignore_excludes_tailwind_input():
    """tailwind.input.css 是 Tailwind CLI 的输入，不该镜像进部署包。"""
    ignored = build._static_ignore("/tmp/static", ["tailwind.input.css", "tailwind.css"])

    assert "tailwind.input.css" in ignored
    assert "tailwind.css" not in ignored


# ── W4-6 缩略图只缩不放 ─────────────────────────────────────────────


def _write_image(path, size):
    Image = pytest.importorskip("PIL.Image")
    Image.new("RGB", size, "red").save(path, "WEBP")


def test_thumbnails_skip_widths_wider_than_source(tmp_path):
    """600px 宽的源图：480 档保留，640/800 档跳过（不许放大）。"""
    source = tmp_path / "src"
    source.mkdir()
    _write_image(source / "mid.webp", (600, 900))
    output = tmp_path / "out"

    count = build.generate_portfolio_thumbs(str(source), str(output))

    assert count == 1
    assert (output / "mid-480.webp").exists()
    assert not (output / "mid-640.webp").exists()
    assert not (output / "mid-800.avif").exists()


def test_thumbnails_skip_everything_when_source_is_narrow(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    _write_image(source / "narrow.webp", (320, 480))
    output = tmp_path / "out"

    assert build.generate_portfolio_thumbs(str(source), str(output)) == 0
    assert list(output.glob("*")) == []


def test_thumbnails_still_generate_all_widths_for_normal_source(tmp_path):
    """回归：1080px 宽的常规源图三档照旧全出（别把守卫写宽了）。"""
    source = tmp_path / "src"
    source.mkdir()
    _write_image(source / "shot.webp", (1080, 1440))
    output = tmp_path / "out"

    assert build.generate_portfolio_thumbs(str(source), str(output)) == 3
    for width in build.PORTFOLIO_THUMB_WIDTHS:
        assert (output / f"shot-{width}.webp").exists()
        assert (output / f"shot-{width}.avif").exists()


# ── W4-5 manifest 必须与产物对得上 ──────────────────────────────────


def _fake_artifact(root, name="index.html", body="hello"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return path


def test_verify_manifest_accepts_matching_tree(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(build, "PUBLIC_DIR", str(tmp_path))
    _fake_artifact(tmp_path)
    build.write_manifest()

    assert build.verify_manifest(str(tmp_path)) == 0
    assert "manifest verified" in capsys.readouterr().out


def test_verify_manifest_rejects_changed_file(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "PUBLIC_DIR", str(tmp_path))
    path = _fake_artifact(tmp_path)
    build.write_manifest()

    path.write_text("tampered", encoding="utf-8")

    assert build.verify_manifest(str(tmp_path)) == 1


def test_verify_manifest_rejects_extra_and_missing_files(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "PUBLIC_DIR", str(tmp_path))
    _fake_artifact(tmp_path, "a.html")
    _fake_artifact(tmp_path, "b.html")
    build.write_manifest()

    _fake_artifact(tmp_path, "sneaked-in.txt")
    (tmp_path / "b.html").unlink()

    assert build.verify_manifest(str(tmp_path)) == 2


def test_verify_manifest_rejects_missing_or_broken_manifest(tmp_path):
    # 没有 manifest.json
    assert build.verify_manifest(str(tmp_path)) == 1
    # manifest.json 是坏 JSON
    (tmp_path / "manifest.json").write_text("{not json", encoding="utf-8")
    assert build.verify_manifest(str(tmp_path)) == 1
    # manifest.json 没有 files 映射
    (tmp_path / "manifest.json").write_text(json.dumps({"count": 3}), encoding="utf-8")
    assert build.verify_manifest(str(tmp_path)) == 1


# ── W9-22 先校验前置条件，再动 public/ ───────────────────────────────


def test_check_image_prerequisites_returns_false_without_sources(tmp_path):
    assert build.check_image_prerequisites(str(tmp_path)) is False


def test_check_image_prerequisites_requires_pillow_and_cairosvg(tmp_path, monkeypatch):
    """有作品集源图时，Pillow / cairosvg / 水印 SVG 缺一不可，且必须在写产物前失败。

    依赖显式注入：本机 CI 用的解释器没有 libcairo（`import cairosvg` 直接失败），
    不能靠“环境里刚好有”来判定。
    """
    source = tmp_path / "src"
    (source / "portfolio").mkdir(parents=True)
    _write_image(source / "portfolio" / "shot.webp", (1080, 1440))
    watermark = source / "icons" / "Limooo-watermark.svg"
    watermark.parent.mkdir(parents=True)
    watermark.write_text("<svg/>", encoding="utf-8")

    # 依赖齐全：通过
    monkeypatch.setattr(build, "Image", object())
    monkeypatch.setattr(build, "ImageDraw", object())
    monkeypatch.setattr(build, "cairosvg", object())
    assert build.check_image_prerequisites(str(source), str(watermark)) is True

    # 缺 Pillow
    monkeypatch.setattr(build, "Image", None)
    with pytest.raises(RuntimeError, match="Pillow"):
        build.check_image_prerequisites(str(source), str(watermark))

    # 缺 cairosvg（本机 .venv-build 就是这种状态）
    monkeypatch.setattr(build, "Image", object())
    monkeypatch.setattr(build, "cairosvg", None)
    with pytest.raises(RuntimeError, match="cairosvg"):
        build.check_image_prerequisites(str(source), str(watermark))

    # 缺水印 SVG
    monkeypatch.setattr(build, "cairosvg", object())
    with pytest.raises(FileNotFoundError):
        build.check_image_prerequisites(str(source), str(tmp_path / "missing.svg"))


def test_generate_watermarks_skips_without_sources(tmp_path):
    """CI 干净 checkout 没有源图：跳过而不是失败（回归）。"""
    assert build.generate_watermarks(str(tmp_path), str(tmp_path / "out")) == 0


def test_remove_public_portfolio_originals_keeps_thumbs(tmp_path):
    """删原图只删顶层图片文件，thumbs/ 子目录必须留下。"""
    portfolio_dir = tmp_path / "portfolio"
    thumbs = portfolio_dir / "thumbs"
    thumbs.mkdir(parents=True)
    (portfolio_dir / "IMG_0001.webp").write_bytes(b"original")
    (portfolio_dir / "IMG_0002.webp").write_bytes(b"original")
    (thumbs / "IMG_0001-640.webp").write_bytes(b"thumb")
    (portfolio_dir / "notes.txt").write_text("keep me", encoding="utf-8")

    assert build.remove_public_portfolio_originals(str(portfolio_dir)) == 2
    assert sorted(p.name for p in portfolio_dir.iterdir()) == ["notes.txt", "thumbs"]
    assert (thumbs / "IMG_0001-640.webp").exists()


def test_main_removes_originals_right_after_copytree(monkeypatch, tmp_path):
    """顺序回归：copytree 之后的第一件事就是删原图（在任何可能失败的步骤之前）。

    前置条件（Pillow/cairosvg/水印 SVG）也必须在写 public/ 之前先跑。
    这里把重活都换成记账桩，只观察调用顺序。
    """
    order: list[str] = []
    static_dir = tmp_path / "static"
    (static_dir / "portfolio").mkdir(parents=True)
    (static_dir / "icons").mkdir(parents=True)
    # main() 会把门禁页 logo 复制到产物根目录，桩构建需要一个存在的文件
    (static_dir / "icons" / "Limooo-xtext.svg").write_text("<svg/>", encoding="utf-8")
    output_dir = tmp_path / "out"

    monkeypatch.setattr(build, "STATIC_DIR", str(static_dir))
    monkeypatch.setattr(build, "PUBLIC_DIR", str(output_dir))
    monkeypatch.setattr(build, "PREVIEW_DIR", str(tmp_path / "preview"))
    monkeypatch.setattr(build, "FUNCTIONS_DIR", str(tmp_path / "functions"))
    monkeypatch.setattr(build, "check_image_prerequisites", lambda *a, **k: order.append("prereq"))
    monkeypatch.setattr(build, "write_pages_edge_config", lambda *a: None)
    monkeypatch.setattr(build, "render_page", lambda *a, **k: "<html></html>")
    monkeypatch.setattr(build, "render_gate", lambda *a, **k: "<html></html>")
    monkeypatch.setattr(build, "generate_portfolio_thumbs", lambda *a, **k: order.append("thumbs") or 0)
    monkeypatch.setattr(build, "generate_watermarks", lambda *a, **k: order.append("watermarks") or 0)
    monkeypatch.setattr(
        build,
        "remove_public_portfolio_originals",
        lambda *a, **k: order.append("remove-originals") or 0,
    )
    monkeypatch.setattr(build, "write_config_functions", lambda: None)
    monkeypatch.setattr(build, "write_i18n_functions", lambda: None)
    monkeypatch.setattr(build, "write_runtime_functions", lambda: None)
    monkeypatch.setattr(build, "write_manifest", lambda: {})

    assert build.main() == 0

    assert order[0] == "prereq", f"前置条件必须先于任何写入：{order}"
    first_remove = order.index("remove-originals")
    assert first_remove < order.index("thumbs"), f"删原图必须早于缩略图：{order}"
    assert first_remove < order.index("watermarks"), f"删原图必须早于水印：{order}"
