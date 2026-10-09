#!/usr/bin/env python3
"""Limooo → Cloudflare Pages 静态化构建脚本

把 Jinja 模板按 4 种语言预渲染成 public/ 下的静态 HTML，并生成：
  - public/<lang>/index.html / services.html / contact.html（中间件按语言吐到干净 URL）
  - public/static/ 静态资源镜像
  - functions/api/i18n/[lang].ts + functions/_data/i18n.ts（前端语言切换用）

运行：python3 build.py
输出目录：public/（git 只保留 .gitkeep，部署用 wrangler pages deploy 直传）
"""

import json
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys

from flask import Flask, g, render_template

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = ImageDraw = None

try:
    import cairosvg
except (ImportError, OSError):
    # cairosvg 依赖本地 libcairo；缺失时 cairocffi 抛的是 OSError 而非
    # ImportError（Linux/无 Homebrew 环境常见），这里一并降级为"不可用"，
    # 由 generate_watermarks 判断是否真的需要水印。
    cairosvg = None


from config import (
    BASE_DIR,
    GATE_HOST,
    LOCALES_DIR,
    PREVIEW_DIR,
    PUBLIC_DIR,
    REDIRECT_PRELOAD_IMAGES,
    ROOT_DOMAIN,
    STATIC_DIR,
    SUPPORTED_LANGS as LANGS,
    load_translations,
)

FUNCTIONS_DIR = os.path.join(BASE_DIR, "functions")


CONTRACT_PATH = os.path.join(BASE_DIR, "config-contract.json")

# 作品集卡片缩略图：只保留足够卡片显示的分辨率，避免首屏直接下载 1080×1440 原图
PORTFOLIO_THUMB_WIDTHS = (480, 640, 800)
PORTFOLIO_THUMB_AVIF_QUALITY = 55

# 并行/备份过程可能产生 “visitor 2.js”“visitors 3.ts” 等带空格的副本，
# 它们不是站点资源；构建时统一跳过，避免误部署到 public/。
_PARALLEL_ARTIFACT_RE = re.compile(r"\s\d+\.(?:ts|js|py|sql|json|md|map)$")


def _static_ignore(dirpath: str, names: list[str]) -> set[str]:
    del dirpath
    ignored = {".DS_Store", "__pycache__"}
    ignored.update(
        name for name in names
        if name.endswith((".bak", ".orig", ".rej"))
        or _PARALLEL_ARTIFACT_RE.search(name)
    )
    return ignored


def _remove_bad_artifacts(root: str) -> None:
    """构建完成后清理外部进程可能再次写入的 .DS_Store / 并行副本。"""
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        for name in filenames:
            if (
                name == ".DS_Store"
                or name.endswith((".bak", ".orig", ".rej"))
                or _PARALLEL_ARTIFACT_RE.search(name)
            ):
                try:
                    os.remove(os.path.join(dirpath, name))
                except OSError:
                    pass
        for name in dirnames:
            if name == "__pycache__":
                shutil.rmtree(os.path.join(dirpath, name), ignore_errors=True)


def write_pages_edge_config(out_dir: str) -> None:
    """生成 Pages _routes.json 与 _headers，静态资源不再进 Functions。"""
    with open(os.path.join(out_dir, "_routes.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "version": 1,
                "include": ["/*"],
                "exclude": [
                    "/static/*",
                    "/favicon.svg",
                    "/Limooo-xtext.svg",
                ],
            },
            f,
            indent=2,
        )
        f.write("\n")
    with open(os.path.join(out_dir, "_headers"), "w", encoding="utf-8") as f:
        f.write(
            "/static/*\n"
            "  Cache-Control: public, max-age=86400, stale-while-revalidate=86400\n"
            "/static/*.css\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.js\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.woff2\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.webp\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.svg\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.avif\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.png\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.jpg\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.jpeg\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.gif\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
            "/static/*.ico\n"
            "  Cache-Control: public, max-age=31536000, immutable\n"
        )


PORTFOLIO_THUMB_QUALITY = 75


def _app_instance(appmod) -> Flask:
    """兼容传入 Flask 模块（旧测试）或 Flask 应用实例（构建期纯渲染）。"""
    return appmod.app if hasattr(appmod, "app") else appmod

# (模板, 输出文件名, 渲染路径) —— 用 Host: limooo.cn 渲染（is_prod=True），
# 导航链接保留子域绝对地址（limooo.cn / services.limooo.cn / contact.limooo.cn），
# 由中间件按主机名把对应语言页面吐到干净 URL，不做语言路径前缀。
PAGES = (
    ("index.html", "index.html", "/", None),
    ("services.html", "services.html", "/services", None),
    ("contact.html", "contact.html", "/contact", None),
    # images.limooo.cn 门面页（继承 base.html），由中间件按主机名吐出到 / 与三个前端路径
    ("images.html", "images.html", "/images", None),
    # 子域专属管理页（visitor.limooo.cn / account.limooo.cn/apple），由中间件按主机名吐出
    ("visitor.html", "visitor.html", "/visitor", None),
    ("apple-account.html", "apple-account.html", "/apple-account", None),
    # 统一跳转页（redirect.limooo.cn）：预渲染默认目标（主站首页），实际跳转参数由中间件拼接
    ("redirect.html", "redirect.html", "/r", "redirect"),
    # 自建登录页已随 Cloudflare Access 接管下线（docs/17 §11.10）。
    # 模板与样式保留在 src/templates/login.html / src/static/css/login.css 作为
    # 备份（不参与构建、不发布），万一要切回自建登录可直接恢复这一行。
)

GATE_I18N_KEYS = (
    ("title", "gate_title"),
    ("heading", "gate_heading"),
    ("location", "gate_location"),
    ("ip", "gate_ip"),
    ("ray", "gate_ray"),
    ("foot", "gate_foot"),
    ("lang_aria", "gate_lang_aria"),
    ("theme_aria", "gate_theme_aria"),
    ("footer_rights", "footer_rights"),
    ("footer_source", "footer_source"),
    ("footer_source_link", "footer_source_link"),
    ("error_sitekey", "gate_error_sitekey"),
    ("error_invalid", "gate_error_invalid"),
    ("error_unavailable", "gate_error_unavailable"),
    ("error_failed", "gate_error_failed"),
    ("error_blocked", "gate_error_blocked"),
    ("error_blocked_detail", "gate_error_blocked_detail"),
    ("retry", "gate_retry"),
)


def _load_gate_i18n() -> dict[str, dict[str, str]]:
    """从 locales/*.json 读取门禁文案，替代 build.py 中的硬编码字典。"""
    translations = load_translations()
    result: dict[str, dict[str, str]] = {}
    for lang in LANGS:
        data = translations[lang]
        path = os.path.join(LOCALES_DIR, f"{lang}.json")
        texts = {}
        for output_key, locale_key in GATE_I18N_KEYS:
            value = data.get(locale_key)
            if not isinstance(value, str) or not value:
                raise RuntimeError(f"{path} is missing gate text field: {locale_key}")
            texts[output_key] = value
        result[lang] = texts
    return result

GATE_I18N = _load_gate_i18n()


def render_page(appmod, template: str, path: str, lang: str, extra=None) -> str:
    """用 Flask 渲染上下文渲染单个页面（Host 固定为 limooo.cn）"""
    app = _app_instance(appmod)
    kwargs = {}
    if extra == "redirect":
        # 预渲染统一跳转页外壳；实际 to / preload 由中间件按请求动态注入。
        kwargs = {
            "to": "{{to}}",
            "preload": False,
            "preload_images": [],
            "preload_placeholder": "{{preload}}",
            "preload_links": "{{preload_links}}",
        }
    with app.test_request_context(path, headers={"Host": ROOT_DOMAIN}):
        g.lang = lang
        html = render_template(template, **kwargs)
    # 模板中 lang 固定为合法静态值以通过静态检查；构建时替换为实际语言
    html = html.replace("<html lang=\"zh-cn\">", f"<html lang=\"{lang}\">", 1)
    # 相对资源统一加根斜杠：模板里是 src="static/..."，在 /zh-cn 这类子路径下
    # 会解析错位，改成 /static/... 后任何路径都正确（配合中间件干净 URL）
    html = html.replace('src="static/', 'src="/static/')
    html = html.replace('href="static/', 'href="/static/')
    return html


def render_gate(appmod, lang: str) -> str:
    """按语言预渲染人机验证门禁页（auth.limooo.cn/__gate）"""
    app = _app_instance(appmod)
    t = GATE_I18N[lang]
    # sitekey 与完整 i18n 由 /__gate/config 运行时下发；构建产物不写密钥相关值。
    turnstile_html = '<div id="turnstile-wrap" class="turnstile-wrap"></div>'
    gate_i18n_json = json.dumps(GATE_I18N, ensure_ascii=False).replace("</", "<\\/")
    with app.test_request_context("/__gate", headers={"Host": GATE_HOST}):
        g.lang = lang
        html = render_template(
            "auth.html",
            lang=lang,
            title=t["title"],
            heading=t["heading"],
            location=t["location"],
            ip=t["ip"],
            ray=t["ray"],
            foot=t["foot"],
            lang_aria=t["lang_aria"],
            theme_aria=t["theme_aria"],
            error_html="{{error}}",
            turnstile_html=turnstile_html,
            turnstile_src="",
            sitekey="",
            gate_i18n=GATE_I18N,
            gate_i18n_json=gate_i18n_json,
            host="{{host}}",
            next="{{next}}",
        )
    html = html.replace("<html lang=\"zh-cn\">", f"<html lang=\"{lang}\">", 1)
    return html


def preview_i18n_patch() -> str:
    """预览版语言切换补丁：内联 4 语言字典，切换语言不依赖 /api/i18n"""
    data: dict[str, dict[str, str]] = load_translations()
    # 内联到 <script> 前转义 </script> 闭合序列，防止翻译文案意外闭合脚本
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return (
        "<script>"
        "(function(){"
        "var ALL=" + payload + ";"
        "window.__PREVIEW_I18N__=ALL;"
        "if (typeof I18N_CACHE === 'undefined') { window.I18N_CACHE = {}; }"
        "Object.keys(ALL).forEach(function(l){I18N_CACHE[l]=ALL[l];});"
        "window.fetchI18n=function(lang,cb){cb(window.__PREVIEW_I18N__[lang]||null);};"
        "})();"
        "</script>"
    )


def write_config_functions() -> None:
    """从 config-contract.json 生成 Pages 侧常量模块（唯一事实源）。"""
    with open(CONTRACT_PATH, encoding="utf-8") as f:
        contract = json.load(f)

    lines = [
        "/** 由 build.py 自动生成，勿手改；修改配置请编辑 config-contract.json。 */",
        "export const CONTRACT = " + json.dumps(contract, ensure_ascii=False, indent=2) + " as const;",
        "",
        "export const ROOT_DOMAIN = CONTRACT.root_domain;",
        "export const BASE_URL = `https://${ROOT_DOMAIN}`;",
        "export const WWW_HOSTNAME = `www.${ROOT_DOMAIN}`;",
        "export const SERVICES_HOSTNAME = `services.${ROOT_DOMAIN}`;",
        "export const CONTACT_HOSTNAME = `contact.${ROOT_DOMAIN}`;",
        "export const VISITOR_HOSTNAME = `visitor.${ROOT_DOMAIN}`;",
        "export const APPLE_ACCOUNT_HOSTNAME = `account.${ROOT_DOMAIN}`;",
        "export const REDIRECT_HOSTNAME = `redirect.${ROOT_DOMAIN}`;",
        "export const GATE_HOSTNAME = `auth.${ROOT_DOMAIN}`;",
        "export const IMAGES_HOSTNAME = `images.${ROOT_DOMAIN}`;",
        "export const GATE_HOST = GATE_HOSTNAME;",
        "export const REDIRECT_HOST = `https://${REDIRECT_HOSTNAME}/`;",
        "export const IMAGE_BASE = `https://${IMAGES_HOSTNAME}`;",
        "export const APPLE_ACCOUNT_DOMAIN = `@${APPLE_ACCOUNT_HOSTNAME}`;",
        "export const PUBLIC_HOSTS: Set<string> = new Set(CONTRACT.public_hosts);",
        "export const MANAGED_HOSTS: Set<string> = new Set(CONTRACT.managed_hosts);",
        "export const SHARED_LANG_HOSTS: Set<string> = new Set(CONTRACT.shared_lang_hosts);",
        "export const PAGE_ROUTES: Record<string, Record<string, string>> = CONTRACT.page_routes;",
        "export const IMAGE_ASSET_HOSTNAME = CONTRACT.image_asset_host;",
        "export const IMAGE_WATERMARK_HOSTNAME = CONTRACT.image_watermark_host;",
        "export const IMAGE_ASSET_BASE = `https://${IMAGE_ASSET_HOSTNAME}`;",
        "export const IMAGE_WATERMARK_BASE = `https://${IMAGE_WATERMARK_HOSTNAME}`;",
        "export const GATE_TRUST = CONTRACT.gate_trust;",
        "export const OBSERVABILITY_HMAC_ENV = CONTRACT.observability_hmac_env;",
        "export const WHITELIST_FILE = CONTRACT.whitelist_file;",
        "export const SUPPORTED_LANGS = CONTRACT.supported_langs;",
        "export const DEFAULT_LANG = CONTRACT.default_lang;",
        "export const KEY_FALLBACK_LANG = CONTRACT.key_fallback_lang;",
        "export const LANG_COOKIE = CONTRACT.lang_cookie;",
        "export const LANG_COOKIE_MAX_AGE = CONTRACT.lang_cookie_max_age;",
        "export const THEME_COOKIE = CONTRACT.theme_cookie;",
        "export const THEME_COOKIE_MAX_AGE = CONTRACT.theme_cookie_max_age;",
        "export const GATE_COOKIE = CONTRACT.gate_cookie;",
        "export const SESSION_COOKIE = CONTRACT.session_cookie;",
        "export const PENDING_COOKIE = CONTRACT.pending_cookie;",
        "export const CSRF_COOKIE = CONTRACT.csrf_cookie;",
        "export const GATE_TTL_SECONDS = CONTRACT.gate_ttl_seconds;",
        "export const SESSION_TTL_SECONDS = CONTRACT.session_ttl_seconds;",
        "export const PENDING_TTL_SECONDS = CONTRACT.pending_ttl_seconds;",
        "",
    ]
    ts_path = os.path.join(FUNCTIONS_DIR, "_lib", "config.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("[build] config functions generated", flush=True)


def write_i18n_functions() -> None:
    """把 locales/*.json 内联进 functions/_data/i18n.ts，并生成 /api/i18n/<lang>"""
    data: dict[str, dict[str, str]] = load_translations()

    ts_path = os.path.join(FUNCTIONS_DIR, "_data", "i18n.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write(
            "// 由 build.py 自动生成，勿手改。\n"
            "export const translations: Record<string, Record<string, string>> = "
            + json.dumps(data, ensure_ascii=False, indent=2)
            + ";\n"
        )

    route_dir = os.path.join(FUNCTIONS_DIR, "api", "i18n")
    os.makedirs(route_dir, exist_ok=True)
    with open(os.path.join(route_dir, "[lang].ts"), "w", encoding="utf-8") as f:
        f.write(
            '// 由 build.py 自动生成，勿手改。\n'
            'import { translations } from "../../_data/i18n";\n'
            "\n"
            "export const onRequestGet = ({ params }: { params: Record<string, string> }) => {\n"
            "  const lang = String((params as { lang?: string }).lang ?? \"\");\n"
            "  const dict = translations[lang];\n"
            "  if (!dict) {\n"
            '    return new Response(JSON.stringify({ error: "unsupported language" }), {\n'
            "      status: 404,\n"
            '      headers: { "Content-Type": "application/json" },\n'
            "    });\n"
            "  }\n"
            "  return new Response(JSON.stringify(dict), {\n"
            "    status: 200,\n"
            '    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },\n'
            "  });\n"
            "};\n"
        )


def write_runtime_functions() -> None:
    """把门禁/跳转页共享文案与预热图片生成 Pages 端独立模块，消除 middleware 重复维护。"""
    redirect_i18n: dict[str, dict[str, str]] = {}
    translations = load_translations()
    for lang in LANGS:
        d = translations[lang]
        redirect_i18n[lang] = {
            "title": d.get("redirect_title", "正在跳转"),
            "text": d.get("redirect_text", "正在跳转..."),
            "footer_rights": d.get("footer_rights", "保留所有权利"),
            "footer_source": d.get("footer_source", "AGPL-3.0"),
            "footer_source_link": d.get("footer_source_link", "源码"),
        }
    output = [
        "// 由 build.py 自动生成，勿手改。",
        "export const GATE_I18N: Record<string, Record<string, string>> = "
        + json.dumps(GATE_I18N, ensure_ascii=False, indent=2)
        + ";",
        "export const REDIRECT_I18N: Record<string, { title: string; text: string; footer_rights: string; footer_source: string; footer_source_link: string }> = "
        + json.dumps(redirect_i18n, ensure_ascii=False, indent=2)
        + ";",
        "export const REDIRECT_PRELOAD_IMAGES = "
        + json.dumps(REDIRECT_PRELOAD_IMAGES, ensure_ascii=False, indent=2)
        + ";",
    ]
    ts_path = os.path.join(FUNCTIONS_DIR, "_data", "runtime.ts")
    os.makedirs(os.path.dirname(ts_path), exist_ok=True)
    with open(ts_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output) + "\n")
    print("[build] runtime functions generated", flush=True)


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest() -> dict:
    """生成 public/manifest.json，并报告与上一次构建产物的差异。

    manifest 不包含时间戳，只包含文件哈希，保证同一源码在干净环境中的输出
    可复现；部署脚本把整个 public/ 上传时，manifest 会作为构建证据一并上传。
    """
    files: dict[str, str] = {}
    for root, _dirs, names in os.walk(PUBLIC_DIR):
        for name in names:
            path = os.path.join(root, name)
            rel = os.path.relpath(path, PUBLIC_DIR).replace(os.sep, "/")
            if rel == "manifest.json":
                continue
            files[rel] = _sha256_file(path)

    manifest_path = os.path.join(PUBLIC_DIR, "manifest.json")
    previous: dict | None = None
    try:
        with open(manifest_path, encoding="utf-8") as f:
            previous_data = json.load(f)
        if isinstance(previous_data, dict) and isinstance(previous_data.get("files"), dict):
            previous = previous_data
    except (OSError, json.JSONDecodeError):
        previous = None

    manifest = {
        "schema_version": 1,
        "tool": "limooo-build",
        "count": len(files),
        "files": files,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    if previous is not None:
        old_files = previous.get("files", {})
        changed = sorted(k for k in files if old_files.get(k) != files[k])
        added = sorted(k for k in files if k not in old_files)
        removed = sorted(k for k in old_files if k not in files)
        if changed or added or removed:
            print(
                f"[build] manifest changed: +{len(added)} -{len(removed)} ~{len(changed)}",
                flush=True,
            )
    return manifest


def generate_portfolio_thumbs(source_dir=None, output_dir=None) -> int:
    """为作品集生成 640/800px WebP 缩略图到构建输出目录。

    缩略图只给首页卡片预览用；完整原图仍保留在 public/static/portfolio/，
    仅用于构建期（生成缩略图与水印变体），不会作为干净原图对外发布。
    """
    # 缩略图始终从源原图（src/static/portfolio）生成，避免依赖构建输出目录
    # 里可能已被清除的原图副本。
    source_dir = source_dir or os.path.join(STATIC_DIR, "portfolio")
    output_dir = output_dir or os.path.join(
        PUBLIC_DIR, "static", "portfolio", "thumbs"
    )
    if Image is None:
        raise RuntimeError(
            "Pillow is not installed, cannot generate portfolio thumbnails. Run "
            "`pip install -r ops/requirements.txt` before build.py."
        )

    # 作品集原图不入库（.gitignore: src/static/portfolio/），CI 干净 checkout
    # 没有该目录；源图缺失时跳过缩略图生成，避免构建失败。
    if not os.path.isdir(source_dir):
        print(
            f"[build] portfolio originals dir missing: {source_dir}; skipping thumbnails",
            flush=True,
        )
        return 0

    os.makedirs(output_dir, exist_ok=True)
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    count = 0

    for name in sorted(os.listdir(source_dir)):
        if not re.search(r"\.(png|jpe?g|webp)$", name, re.I):
            continue
        src_path = os.path.join(source_dir, name)
        try:
            with Image.open(src_path) as opened:
                image = opened.convert("RGB")
        except Exception as exc:
            print(f"[build] thumbnail skip {name}: {exc}", flush=True)
            continue

        base = os.path.splitext(name)[0]
        for width in PORTFOLIO_THUMB_WIDTHS:
            height = round(image.height * width / image.width)
            thumb = image.resize((width, height), resampling)
            out_path = os.path.join(output_dir, f"{base}-{width}.webp")
            # 并行构建可能重建 public/ 后删掉目录；保存前再次确保目录存在。
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            thumb.save(
                out_path,
                "WEBP",
                quality=PORTFOLIO_THUMB_QUALITY,
                method=6,
            )
            avif_path = os.path.join(output_dir, f"{base}-{width}.avif")
            thumb.save(
                avif_path,
                "AVIF",
                quality=PORTFOLIO_THUMB_AVIF_QUALITY,
                method=6,
                speed=6,
            )
            count += 1

    print(f"[build] portfolio thumbnails: {count}", flush=True)
    return count


def generate_watermarks(source_root=None, out_root=None) -> int:
    """从源原图生成左下角水印变体到 public/static/wm/。

    规则（与 Worker 里的 shouldWatermark 保持一致）：
      - 只处理 portfolio/ 下的 png / jpg / jpeg / webp
      - 其他路径（icons / qr-codes 等）不生成水印变体
    水印尺寸：图片短边的 25%（下限 96px），左下角 2% 边距（下限 12px）。
    水印原文件约 40% 透明度，这里提高到约 72%，并垫一块半透明深色圆角底衬，
    保证浅色照片上也能看清。想调整显眼程度直接改下面的常量。
    """
    # 显眼程度参数（可按喜好调整）
    WATERMARK_SCALE = 0.25       # 水印宽度 = 图片短边的比例
    WATERMARK_MIN_W = 96         # 水印宽度下限（px）
    WATERMARK_ALPHA_BOOST = 1.8  # 水印本身透明度增强系数（40% → ~72%）
    BACKDROP_ALPHA = 105         # 深色底衬不透明度（0-255，0 = 不要底衬）
    PAD_RATIO = 0.08             # 底衬相对水印宽度的内边距

    # A2：水印变体由源原图（src/static/portfolio）生成，公开 bundle 只发布
    # /static/wm/portfolio/*，原图不再对外。
    source_root = source_root or STATIC_DIR
    out_root = out_root or os.path.join(PUBLIC_DIR, "static", "wm")

    # CI runner 不含 gitignore 的 src/static/portfolio：没有源图时无需水印，
    # 跳过而不是失败；只有确实要水印却缺素材/缺依赖时才报错。
    portfolio_dir = os.path.join(source_root, "portfolio")
    has_portfolio = os.path.isdir(portfolio_dir) and any(
        name.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
        for name in os.listdir(portfolio_dir)
    )

    if Image is None or ImageDraw is None:
        if has_portfolio:
            raise RuntimeError(
                "Pillow is not installed, cannot generate portfolio watermarks. Run "
                "`pip install -r ops/requirements.txt` before build.py."
            )
        print("[build] no portfolio files to watermark, skipping watermark generation", flush=True)
        return 0

    wm_path = os.path.join(STATIC_DIR, "icons", "Limooo-watermark.svg")

    if cairosvg is None:
        if has_portfolio:
            raise RuntimeError(
                "SVG watermarking requires cairosvg (and local libcairo)"
            )
        print("[build] no portfolio files to watermark, skipping watermark generation", flush=True)
        return 0
    if not os.path.exists(wm_path):
        if has_portfolio:
            raise FileNotFoundError(
                "missing watermark asset: src/static/icons/Limooo-watermark.svg"
            )
        print("[build] no portfolio files to watermark, skipping watermark generation", flush=True)
        return 0
    os.makedirs(out_root, exist_ok=True)

    wm = Image.open(io.BytesIO(cairosvg.svg2png(url=wm_path))).convert("RGBA")
    wm_w0, wm_h0 = wm.size
    count = 0

    for root, _dirs, files in os.walk(source_root):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), source_root)
            # 只给作品集图片加水印
            if not rel.replace(os.sep, "/").startswith("portfolio/"):
                continue
            if not re.search(r"\.(png|jpe?g|webp)$", name, re.I):
                continue
            try:
                with Image.open(os.path.join(root, name)) as opened:
                    im = opened.convert("RGBA")
            except Exception as exc:  # 无法解码的图直接跳过
                print(f"[build] watermark skip {rel}: {exc}", flush=True)
                continue

            base = min(im.size)
            target_w = max(WATERMARK_MIN_W, round(base * WATERMARK_SCALE))
            wm_h = max(1, round(wm_h0 * target_w / wm_w0))
            margin = max(12, round(base * 0.02))
            resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            wm_resized = wm.resize((target_w, wm_h), resampling)
            # 提高水印本身的不透明度（原文件约 40% → ~72%）
            if WATERMARK_ALPHA_BOOST != 1:
                r, g, b, a = wm_resized.split()
                a = a.point(lambda v: min(255, int(round(float(v) * WATERMARK_ALPHA_BOOST))))
                wm_resized = Image.merge("RGBA", (r, g, b, a))

            canvas = im.copy()
            # 半透明深色圆角底衬：浅色照片上水印也清晰
            if BACKDROP_ALPHA > 0:
                pad = max(8, round(target_w * PAD_RATIO))
                bg = Image.new("RGBA", im.size, (0, 0, 0, 0))
                box = (
                    max(0, margin - pad),
                    max(0, im.size[1] - wm_h - margin - pad),
                    min(im.size[0], margin + target_w + pad),
                    im.size[1] - margin + pad,
                )
                ImageDraw.Draw(bg).rounded_rectangle(
                    box, radius=max(8, pad), fill=(12, 16, 20, BACKDROP_ALPHA)
                )
                canvas = Image.alpha_composite(canvas, bg)
            canvas.alpha_composite(
                wm_resized,
                (margin, im.size[1] - wm_h - margin),
            )

            ext = name.rsplit(".", 1)[-1].lower()
            if ext == "png":
                fmt, save_im, kwargs = "PNG", canvas, {}
            elif ext in ("jpg", "jpeg"):
                fmt, save_im, kwargs = "JPEG", canvas.convert("RGB"), {"quality": 92}
            else:
                fmt, save_im, kwargs = "WEBP", canvas.convert("RGB"), {"quality": 92}

            out_path = os.path.join(out_root, rel)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            save_im.save(out_path, fmt, **kwargs)
            count += 1

    print(f"[build] watermarked variants: {count}", flush=True)
    return count


def remove_public_portfolio_originals(portfolio_dir: str) -> int:
    """删除 public/static/portfolio 顶层原图，只保留 thumbs/ 子目录。

    A2：作品集完整原图不再对外发布，只公开水印变体（/static/wm/portfolio/*）与
    首页缩略图（/static/portfolio/thumbs/*）。该函数同时清掉构建期间可能混入的
    并行副本（如 “IMG_0064 2.webp”）。
    """
    # CI 干净 checkout 没原图，public/static/portfolio 可能不存在；缺失即跳过。
    if not os.path.isdir(portfolio_dir):
        print(
            f"[build] public portfolio originals dir missing: {portfolio_dir}; nothing to remove",
            flush=True,
        )
        return 0

    removed = 0
    for name in sorted(os.listdir(portfolio_dir)):
        full = os.path.join(portfolio_dir, name)
        if os.path.isfile(full) and re.search(
            r"\.(png|jpe?g|webp|avif|gif|bmp|ico)$", name, re.I
        ):
            try:
                os.remove(full)
                removed += 1
            except OSError as exc:
                print(f"[build] remove public original skip {name}: {exc}", flush=True)
    print(f"[build] removed public portfolio originals: {removed}", flush=True)
    return removed


def main() -> int:
    # 从 data/whitelist.txt 生成门禁信任配置，与中间件共用同一事实源。
    subprocess.run(
        [
            sys.executable,
            str(os.path.join(BASE_DIR, "ops", "check_gate_trust.py")),
            "--emit",
        ],
        check=True,
    )
    # 构建态标记：只读最小 Flask 渲染器，不导入业务 app，不初始化数据库/密钥。
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    os.environ.setdefault("LIMOOO_BUILD", "1")
    from render_app import RENDER_APP as appmod

    # 清空并重建输出目录（public/ 为纯生成产物）
    if os.path.isdir(PUBLIC_DIR):
        _remove_bad_artifacts(PUBLIC_DIR)
        shutil.rmtree(PUBLIC_DIR)
    os.makedirs(PUBLIC_DIR)

    # Pages 边缘配置：静态资源完全绕过 Functions（否则每次请求都先冷启动
    # 中间件后再读 ASSETS）；公开 HTML 仍由中间件按语言/门禁路由。
    write_pages_edge_config(PUBLIC_DIR)

    # 1) 每个语言渲染所有公开页面
    for lang in LANGS:
        lang_dir = os.path.join(PUBLIC_DIR, lang)
        os.makedirs(lang_dir, exist_ok=True)
        for template, filename, path, extra in PAGES:
            html = render_page(appmod, template, path, lang, extra)
            with open(os.path.join(lang_dir, filename), "w", encoding="utf-8") as f:
                f.write(html)
        # 人机验证门禁页（auth.limooo.cn/__gate）
        with open(os.path.join(lang_dir, "auth.html"), "w", encoding="utf-8") as f:
            f.write(render_gate(appmod, lang))
        print(f"[build] {lang} rendered", flush=True)

    # 3) 静态资源镜像
    shutil.copytree(
        STATIC_DIR,
        os.path.join(PUBLIC_DIR, "static"),
        dirs_exist_ok=True,
        ignore=_static_ignore,
    )
    # 3.1) 作品集卡片缩略图（首页只加载这些，不再直接下载 1080×1440 原图）
    generate_portfolio_thumbs(
        os.path.join(STATIC_DIR, "portfolio"),
        os.path.join(PUBLIC_DIR, "static", "portfolio", "thumbs"),
    )
    # 3.2) 水印变体（A2：公开 bundle 只发布水印全图 /static/wm/portfolio/*）
    generate_watermarks(STATIC_DIR, os.path.join(PUBLIC_DIR, "static", "wm"))
    # 3.3) 移除公开 bundle 里的作品集原图，杜绝 /static/portfolio/<图> 裸链干净原图
    remove_public_portfolio_originals(
        os.path.join(PUBLIC_DIR, "static", "portfolio")
    )
    # 门禁验证页引用的根路径 logo（放行路径之一）
    shutil.copy2(
        os.path.join(STATIC_DIR, "icons", "Limooo-xtext.svg"),
        os.path.join(PUBLIC_DIR, "Limooo-xtext.svg"),
    )

    # 4) i18n Functions（前端语言切换接口）
    write_config_functions()
    write_i18n_functions()
    write_runtime_functions()

    # 5) 子域预览（本地预览用，不入库）：生成的预览输出到 preview/templates/，
    #    每个子域页面一个文件（预览默认语言），不按语言分文件夹，
    #    并镜像 static/ 资源，HTML 里的图片引用改为本地相对路径（离线可看）
    PREVIEW_OUT = os.path.join(PREVIEW_DIR, "templates")
    if os.path.isdir(PREVIEW_DIR):
        shutil.rmtree(PREVIEW_DIR)
    os.makedirs(PREVIEW_OUT)
    shutil.copytree(
        STATIC_DIR,
        os.path.join(PREVIEW_DIR, "static"),
        dirs_exist_ok=True,
        ignore=_static_ignore,
    )
    # 预览目录直接复用 public/ 已生成的缩略图（同一批源图、同一套参数），
    # 避免同一次构建把 18 张缩略图重新编码一遍（webp + avif 共 36 个文件）。
    _preview_thumbs = os.path.join(PREVIEW_DIR, "static", "portfolio", "thumbs")
    _public_thumbs = os.path.join(PUBLIC_DIR, "static", "portfolio", "thumbs")
    if os.path.isdir(_public_thumbs):
        shutil.copytree(_public_thumbs, _preview_thumbs, dirs_exist_ok=True)
        print(
            "[build] preview thumbnails reused: "
            f"{len(os.listdir(_preview_thumbs))} files",
            flush=True,
        )
    else:
        generate_portfolio_thumbs(
            os.path.join(STATIC_DIR, "portfolio"),
            _preview_thumbs,
        )
    PREVIEW_LANG = "zh-cn"
    src = os.path.join(PUBLIC_DIR, PREVIEW_LANG)
    for name in os.listdir(src):
        if name.endswith(".html"):
            html = open(os.path.join(src, name), encoding="utf-8").read()
            # 资源引用本地化：https://limooo.cn/static/... 与
            # https://images.limooo.cn/static/... 与 image.limooo.cn/...
            # → ../static/...
            # （只替换 HTML 标签属性，不碰 JS 里的绝对 URL）
            html = re.sub(
                r'(src|href|data-qr)="https://(?:limooo\.cn/static|images\.limooo\.cn/static|image\.limooo\.cn)/',
                r'\1="../static/',
                html,
            )
            # 内联 CSS 里的根路径资源（门禁页 @font-face 的 url(/static/...)）同步本地化
            html = html.replace("url(/static/", "url(../static/")
            html = html.replace(
                'src="/Limooo-xtext.svg"',
                'src="../static/icons/Limooo-xtext.svg"',
            )
            # 站内导航本地化：https://<子域>.limooo.cn → 同目录本地文件
            for sub, page in (
                ("services", "services.html"),
                ("contact", "contact.html"),
                ("visitor", "visitor.html"),
                ("apple-account", "apple-account.html"),
            ):
                html = re.sub(rf'href="https://{sub}\.limooo\.cn/?', f'href="{page}"', html)
            html = re.sub(r'href="https://limooo\.cn/?', 'href="index.html"', html)
            # redirect 预览默认目标也指向本地首页
            html = re.sub(r'url=https://limooo\.cn/', 'url=index.html', html)
            html = html.replace('"https://limooo.cn/"', '"index.html"')
            # 门禁/跳转页的运行时注入占位符，在本地预览中填默认值
            html = html.replace("{{host}}", "limooo.cn")
            html = html.replace("{{next}}", "/")
            html = html.replace("{{error}}", "")
            html = html.replace("{{preload}}", "[]")
            html = html.replace("{{preload_links}}", "")
            html = html.replace("{{to}}", "index.html")
            # redirect 预览：静止展示跳转页，不自动跳走
            if name == "redirect.html":
                html = re.sub(r'<meta http-equiv="refresh"[^>]*>', '', html)
                html = html.replace(
                    "function go() { location.replace(target); }",
                    "function go() {}",
                )
            # 语言切换本地化：内联 4 语言字典（页面内可切换语言，无需 /api/i18n）
            html = html.replace("</body>", preview_i18n_patch() + "</body>")
            with open(os.path.join(PREVIEW_OUT, name), "w", encoding="utf-8") as f:
                f.write(html)
    # 预览索引（列出所有子域页面，模板在 Flask/src/templates/preview.html）
    with appmod.test_request_context("/", headers={"Host": "limooo.cn"}):
        index_html = render_template(
            "preview.html",
            pages=[
                "index.html",
                "services.html",
                "contact.html",
                "visitor.html",
                "apple-account.html",
                "redirect.html",
                "auth.html",
            ],
        )
    with open(os.path.join(PREVIEW_OUT, "preview.html"), "w", encoding="utf-8") as f:
        f.write(index_html)
    with open(os.path.join(PREVIEW_DIR, ".gitkeep"), "w", encoding="utf-8") as f:
        pass
    print(f"[build] preview generated for {len(LANGS)} languages", flush=True)

    # 保留 .gitkeep（git 只跟踪它，生成内容不入库）
    with open(os.path.join(PUBLIC_DIR, ".gitkeep"), "w", encoding="utf-8"):
        pass

    # 外部进程可能在构建期间写入 .DS_Store / “file 2.ext” 副本，
    # 在生成 manifest 和部署前统一清理。
    _remove_bad_artifacts(PUBLIC_DIR)

    # 生成构建清单；部署脚本会在上传前校验产物哈希。
    write_manifest()

    total = 0
    for _root, _dirs, files in os.walk(PUBLIC_DIR):
        total += len(files)
    print(f"[build] done, {total} files in public/", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
