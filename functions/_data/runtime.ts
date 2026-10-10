/**
 * Limooo - serverless personal website and admin system
 *
 * Copyright (C) 2026 Limooo <https://limooo.cn/>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// 由 build.py 自动生成，勿手改。
export const GATE_I18N: Record<string, Record<string, string>> = {
  "zh-cn": {
    "title": "正在验证您是否为人类…",
    "heading": "请完成人机验证后再访问本站",
    "location": "Location",
    "ip": "IP",
    "ray": "Ray ID",
    "foot": "由 Limooo 边缘安全提供保护",
    "lang_aria": "切换语言",
    "theme_aria": "切换主题",
    "footer_rights": "保留所有权利",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "源码",
    "error_sitekey": "服务配置错误：未设置 TURNSTILE_SITEKEY。",
    "error_invalid": "请求无效，请重试。",
    "error_unavailable": "验证服务暂时不可用，请稍后重试。",
    "error_failed": "验证未通过，请重试。",
    "error_blocked": "你已被 WAF 规则拦截",
    "error_blocked_detail": "请关闭 VPN 后重试。",
    "retry": "重试"
  },
  "en-us": {
    "title": "Verifying you are human…",
    "heading": "Please complete this CAPTCHA to access the site.",
    "location": "Location",
    "ip": "IP",
    "ray": "Ray ID",
    "foot": "Secured by Limooo Edge Security",
    "lang_aria": "Switch language",
    "theme_aria": "Toggle theme",
    "footer_rights": "All rights reserved",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "Source",
    "error_sitekey": "Server configuration error: TURNSTILE_SITEKEY is not set.",
    "error_invalid": "Invalid request. Please try again.",
    "error_unavailable": "Verification service temporarily unavailable. Please try again in a moment.",
    "error_failed": "Verification failed. Please try again.",
    "error_blocked": "You have been blocked by WAF Rules",
    "error_blocked_detail": "Please turn off your VPN and try again.",
    "retry": "Try again"
  },
  "ja-jp": {
    "title": "人間であることを確認しています…",
    "heading": "このサイトにアクセスするには、人認証を完了してください",
    "location": "Location",
    "ip": "IP",
    "ray": "Ray ID",
    "foot": "Limooo Edge Security により保護されています",
    "lang_aria": "言語切替",
    "theme_aria": "テーマ切替",
    "footer_rights": "すべての権利を保有",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "ソースコード",
    "error_sitekey": "サーバー設定エラー：TURNSTILE_SITEKEY が設定されていません。",
    "error_invalid": "リクエストが無効です。もう一度お試しください。",
    "error_unavailable": "認証サービスが一時的に利用できません。しばらくしてからもう一度お試しください。",
    "error_failed": "認証に失敗しました。もう一度お試しください。",
    "error_blocked": "WAF ルールによりブロックされています",
    "error_blocked_detail": "VPN をオフにして、もう一度お試しください。",
    "retry": "再試行"
  },
  "ko-kr": {
    "title": "사람인지 확인하는 중…",
    "heading": "사이트에 접속하려면 인증을 완료해 주세요",
    "location": "Location",
    "ip": "IP",
    "ray": "Ray ID",
    "foot": "Limooo Edge Security가 보호합니다",
    "lang_aria": "언어 전환",
    "theme_aria": "테마 전환",
    "footer_rights": "모든 권리 보유",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "소스 코드",
    "error_sitekey": "서버 설정 오류: TURNSTILE_SITEKEY가 설정되지 않았습니다.",
    "error_invalid": "잘못된 요청입니다. 다시 시도해 주세요.",
    "error_unavailable": "인증 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    "error_failed": "인증에 실패했습니다. 다시 시도해 주세요.",
    "error_blocked": "WAF 규칙에 의해 차단되었습니다",
    "error_blocked_detail": "VPN을 끈 뒤 다시 시도해 주세요.",
    "retry": "다시 시도"
  }
};
export const REDIRECT_I18N: Record<string, { title: string; text: string; footer_rights: string; footer_source: string; footer_source_link: string }> = {
  "zh-cn": {
    "title": "正在跳转…",
    "text": "正在跳转... (・ω・)",
    "footer_rights": "保留所有权利",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "源码"
  },
  "en-us": {
    "title": "Redirecting…",
    "text": "Redirecting... (・ω・)",
    "footer_rights": "All rights reserved",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "Source"
  },
  "ja-jp": {
    "title": "リダイレクト中…",
    "text": "リダイレクト中... (・ω・)",
    "footer_rights": "すべての権利を保有",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "ソースコード"
  },
  "ko-kr": {
    "title": "리디렉션 중…",
    "text": "리다이렉트 중... (・ω・)",
    "footer_rights": "모든 권리 보유",
    "footer_source": "AGPL-3.0",
    "footer_source_link": "소스 코드"
  }
};
export const REDIRECT_PRELOAD_IMAGES = [
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0203-800.webp",
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0146-800.webp",
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0130-800.webp",
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0244-800.webp",
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0115-800.webp",
  "https://images.limooo.cn/static/portfolio/thumbs/IMG_0179-800.webp"
];
