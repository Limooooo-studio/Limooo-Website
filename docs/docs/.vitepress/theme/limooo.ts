/**
 * 与主站共享 cookie 的桥接层（docs.limooo.cn ↔ limooo.cn）。
 *
 * 主站 cookie（见 Flask/src/static/js/base.js 与 functions/_lib/routing.ts）：
 *   user_lang_preference = zh-cn | en-us | ja-jp | ko-kr   Domain=.limooo.cn
 *   limooo_theme         = light | dark                     Domain=.limooo.cn
 *
 * 语言 URL 约定：语言码是页面路径的**最后一段**，内容页一律显式带上（含默认
 * 语言 zh-cn），无后缀路径由 _redirects 302 到 /.../zh-cn：
 *   /video-platform/zh-cn      zh-cn（/video-platform 302 到这里）
 *   /video-platform/en-us      en-us
 *   /README/zh-cn              README 页
 *   /en-us                     首页的 en-us 版本（首页没有 /zh-cn，`/` 就是 zh-cn）
 *
 * 这里做三件事：
 *   1. 读主站主题 cookie → 首次访问时喂给 VitePress appearance；
 *   2. 监控 VitePress 的深色切换 → 回写 limooo_theme；
 *   3. 路由变化时把当前语言回写 user_lang_preference；进入无后缀页面时，
 *      若 cookie 指定了别的语言且目标页面存在，则每会话跳转一次。
 */

export const LANG_COOKIE = 'user_lang_preference'
export const THEME_COOKIE = 'limooo_theme'
export const APPEARANCE_KEY = 'vitepress-theme-appearance'

export const DEFAULT_LANG = 'zh-cn'
export const LANGS = ['zh-cn', 'en-us', 'ja-jp', 'ko-kr'] as const

const ROOT_DOMAIN = 'limooo.cn'
const COOKIE_MAX_AGE = 31536000
const REDIRECT_FLAG = 'limooo-docs-lang-redirect'

/** 在 <head> 里、VitePress 自己的 check-dark-mode 之前执行的同步脚本。 */
export const THEME_BOOTSTRAP_SCRIPT = `;(() => {
  try {
    if (localStorage.getItem('${APPEARANCE_KEY}')) return
    var m = document.cookie.match(/(?:^|;\\s*)${THEME_COOKIE}=(light|dark)/)
    if (m) localStorage.setItem('${APPEARANCE_KEY}', m[1])
  } catch (e) {}
})()`

function cookieAttributes(): string {
  const host = location.hostname
  const domain =
    host === ROOT_DOMAIN || host.endsWith('.' + ROOT_DOMAIN)
      ? '; domain=.' + ROOT_DOMAIN
      : ''
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  return `; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}${domain}`
}

export function readCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')
  )
  return match ? decodeURIComponent(match[1]) : null
}

export function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}${cookieAttributes()}`
}

function pathSegments(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean)
}

/** 从 URL 路径推导语言码（最后一段是语言码则用它，否则是默认语言）。 */
export function langFromPath(path: string): string {
  const segments = pathSegments(path)
  const last = segments[segments.length - 1]
  return last && (LANGS as readonly string[]).includes(last)
    ? last
    : DEFAULT_LANG
}

/** 路径是否显式带语言后缀。 */
export function hasLangSuffix(path: string): boolean {
  const segments = pathSegments(path)
  const last = segments[segments.length - 1]
  return !!last && (LANGS as readonly string[]).includes(last)
}

/** 把同一个页面换成另一种语言的路径。 */
export function pathForLang(path: string, lang: string): string {
  const segments = pathSegments(path)
  if (hasLangSuffix(path)) segments.pop()
  const base = segments.length ? '/' + segments.join('/') : '/'
  // 首页是唯一例外：`/` 就是 zh-cn；内容页的默认语言也要带 /zh-cn 后缀
  if (base === '/') return lang === DEFAULT_LANG ? '/' : `/${lang}`
  return `${base}/${lang}`
}

export function isValidLang(value: string | null): value is string {
  return value !== null && (LANGS as readonly string[]).includes(value)
}

function syncLangCookie(path: string): void {
  const lang = langFromPath(path)
  if (readCookie(LANG_COOKIE) !== lang) writeCookie(LANG_COOKIE, lang)
}

function syncThemeCookie(): void {
  const value = document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light'
  if (readCookie(THEME_COOKIE) !== value) writeCookie(THEME_COOKIE, value)
}

function watchAppearance(): void {
  syncThemeCookie()
  new MutationObserver(syncThemeCookie).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
}

interface RouterLike {
  onAfterRouteChange?: (to: string) => unknown
  go: (to: string) => unknown
}

/**
 * 只在「当前页面没写语言后缀」且「cookie 指定了非默认语言」时跳一次。
 * 先 HEAD 探一下目标页是否存在，避免把没有译文的页面跳到 404。
 * 返回 true 表示正在跳转（此时不要回写 cookie，让目标页去写）。
 */
async function maybeRedirectToPreferred(
  router: RouterLike,
  preferred: string | null
): Promise<boolean> {
  if (hasLangSuffix(location.pathname)) return false
  if (!isValidLang(preferred) || preferred === DEFAULT_LANG) return false
  try {
    if (sessionStorage.getItem(REDIRECT_FLAG)) return false
    sessionStorage.setItem(REDIRECT_FLAG, '1')
  } catch {
    return false
  }
  const target = pathForLang(location.pathname, preferred)
  if (target === location.pathname) return false
  try {
    const response = await fetch(target, { method: 'HEAD' })
    if (response.ok) {
      void router.go(target)
      return true
    }
  } catch {
    /* 探不到就当没有译文，保持当前页面 */
  }
  return false
}

export function installCookieBridge(router: RouterLike): void {
  if (typeof document === 'undefined') return

  watchAppearance()

  // 先读偏好再回写：否则 syncLangCookie 会立刻把 cookie 改成当前页语言，
  // 偏好信息就丢了，跳转也就不会发生。
  const preferred = readCookie(LANG_COOKIE)
  void maybeRedirectToPreferred(router, preferred).then((redirecting) => {
    if (!redirecting) syncLangCookie(location.pathname)
  })

  const previous = router.onAfterRouteChange
  router.onAfterRouteChange = async (to: string) => {
    await previous?.(to)
    syncLangCookie(to)
  }
}
