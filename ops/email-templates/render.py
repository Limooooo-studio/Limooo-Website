#!/usr/bin/env python3
"""Limooo shared transactional-email renderer.

DEPRECATED (2026-10-11, docs/22 W7-13): nothing calls `render_email()` any more.
The VPS Flask app that used it is gone, and Cloudflare Access replaced the login
mail flow. The one production mail that still goes out is the **status-worker
alert** (`ops/status-worker/src/index.ts`, `ALERT_I18N` + `buildAlertEmail`),
which is the single owner of that copy -- `health-alert.i18n.json` in this
directory is a tombstone, not a second source.

The framework itself is kept because it is the only four-language HTML mail layout
in the repository, and `tests/test_email_templates.py` keeps it working. If a new
mail sender is added, either reuse this module or delete it -- never add a third copy.

Usage (Python):
    from render import render_email
    html, plaintext = render_email(
        lang="zh-cn",
        title="您的验证码",
        body="感谢您使用 Limooo Studio 的服务。请使用下方验证码完成您的请求。",
        code="123456",                 # 可选：显示高亮块
        cta_label="前往查看",         # 可选：主按钮
        cta_url="https://limooo.cn",
        hint="如果您未发起此操作，可忽略本邮件。",  # 可选：次要提示
        preheader="您的验证码是 123456",  # 可选：收件箱预览
    )

CLI debug: python3 render.py --lang en-us --title 'Hi' --body 'Hello' --code 123456
"""
from __future__ import annotations

import argparse
import html as html_lib
import json
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
FRAMEWORK_HTML = DIR / "framework.html"
FRAMEWORK_I18N = DIR / "framework.i18n.json"

SUPPORTED_LANGS = ("zh-cn", "en-us", "ja-jp", "ko-kr")


def _load_i18n() -> dict:
    with open(FRAMEWORK_I18N, encoding="utf-8") as f:
        return json.load(f)


def _code_block(code: str, lang: str) -> str:
    """验证码/关键值高亮块（绿色、大字、等宽数字间距）。"""
    return (
        '<table align="center" width="100%" border="0" cellPadding="0" cellSpacing="0"'
        ' role="presentation" style="background-color:#f4f4f5;border-radius:12px;margin:24px 0;'
        'border:1px solid #e4e4e7"><tbody><tr><td style="padding:24px;text-align:center">'
        f'<p style="font-size:32px;line-height:44px;color:#05A5A6;font-weight:600;letter-spacing:8px;'
        f'margin:0;font-variant-numeric:tabular-nums">{code}</p>'
        "</td></tr></tbody></table>"
    )


def _cta_block(label: str, url: str) -> str:
    """主按钮（青绿色 brand 色 #05A5A6）。"""
    safe_label = html_lib.escape(label)
    safe_url = html_lib.escape(url, quote=True)
    return (
        '<table role="presentation" cellPadding="0" cellSpacing="0" align="center"'
        ' style="margin:24px 0"><tbody><tr><td align="center">'
        f'<a href="{safe_url}" style="background-color:#05A5A6;border-radius:8px;color:#ffffff;'
        f'display:inline-block;font-size:14px;font-weight:600;line-height:1;padding:14px 28px;'
        f'text-decoration:none">{safe_label}</a>'
        "</td></tr></tbody></table>"
    )


def _strip_tags(text: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", text).replace("&nbsp;", " ").strip()


def render_email(
    lang: str,
    *,
    title: str,
    body: str,
    code: str | None = None,
    cta_label: str | None = None,
    cta_url: str | None = None,
    hint: str | None = None,
    preheader: str | None = None,
    footer_rights: str | None = None,
) -> tuple[str, str]:
    """渲染通用邮件框架，返回 (html, plaintext)。"""
    if lang not in SUPPORTED_LANGS:
        raise ValueError(f"unsupported lang: {lang}")
    i18n = _load_i18n()
    d = i18n[lang]

    # 可选块（用注释包裹，置空则整段移除）
    code_block = _code_block(code, lang) if code else ""
    cta_block = _cta_block(cta_label, cta_url or "#") if cta_label else ""
    hint_html = (
        f'<p style="font-size:14px;line-height:24px;color:#71717a;margin:16px 0">'
        f"{hint or d['default_hint']}</p>"
        if (hint or d.get("default_hint"))
        else ""
    )
    footer_text = footer_rights or d["footer_rights"]

    html = FRAMEWORK_HTML.read_text(encoding="utf-8")
    html = html.replace("__TITLE__", html_lib.escape(title))
    html = html.replace("__PREHEADER__", html_lib.escape(preheader or title))
    html = html.replace("__BODY__", body)
    # 可选块先替换，再删除被标记为空的块
    html = (
        html.replace("<!--BR_CHECK__CODE_BLOCK__-->", code_block)
        .replace("<!--BR_CHECK__CTA_BLOCK__-->", cta_block)
        .replace("<!--BR_CHECK__HINT__-->", hint_html)
    )
    # 若某可选块为空，清掉对应的骨架标记（无副作用）
    html = html.replace("<!--BR_CHECK__CODE_BLOCK__-->", "").replace(
        "<!--BR_CHECK__CTA_BLOCK__-->", ""
    ).replace("<!--BR_CHECK__HINT__-->", "")
    html = html.replace("__FOOTER_RIGHTS__", html_lib.escape(footer_text))

    plain = "\n".join(
        p
        for p in [
            title,
            _strip_tags(body),
            code,
            _strip_tags(hint_html),
        ]
        if p
    )
    return html, plain


def _main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en-us", choices=SUPPORTED_LANGS)
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--code")
    ap.add_argument("--cta-label")
    ap.add_argument("--cta-url")
    ap.add_argument("--hint")
    ap.add_argument("--preheader")
    args = ap.parse_args()
    try:
        html, plain = render_email(
            args.lang,
            title=args.title,
            body=args.body,
            code=args.code,
            cta_label=args.cta_label,
            cta_url=args.cta_url,
            hint=args.hint,
            preheader=args.preheader,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[render] ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    # 纯英文、无装饰符号（AGENTS.md）：标题行本身就是分隔，不需要 === === 包装。
    print("plain")
    print(plain)
    print()
    print("html")
    print(html)


if __name__ == "__main__":
    _main()
