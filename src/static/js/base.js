/* 跨端契约事实全部由 build.py 注入 <body data-*>（模板 _lang_attrs.html），
   前端只读、不写死：加语言 / 改 cookie 名或 TTL 只改 config-contract.json。 */
var BODY = document.body;
function bodyAttr(name, fallback) {
    var value = BODY && BODY.getAttribute(name);
    return value === null || value === undefined || value === '' ? (fallback || '') : value;
}
var DEFAULT_LANG = bodyAttr('data-default-lang', 'en-us');
var SUPPORTED_LANGS = bodyAttr('data-supported-langs').split(/\s+/).filter(function (code) { return code; });
var ROOT_DOMAIN = bodyAttr('data-root-domain', 'limooo.cn');
var LANG_COOKIE = bodyAttr('data-lang-cookie', 'user_lang_preference');
var LANG_COOKIE_MAX_AGE = bodyAttr('data-lang-cookie-max-age', '31536000');
var THEME_COOKIE = bodyAttr('data-theme-cookie', 'limooo_theme');
var THEME_COOKIE_MAX_AGE = bodyAttr('data-theme-cookie-max-age', '31536000');
function sharedCookieDomain() {
    return location.hostname === ROOT_DOMAIN || location.hostname.endsWith('.' + ROOT_DOMAIN)
        ? '; domain=.' + ROOT_DOMAIN
        : '';
}
document.documentElement.lang = bodyAttr('data-lang', DEFAULT_LANG);

/* ═══════════════════════════════════════════════════════════════
       图片预加载（仅预加载二维码等小资源；带 loading="lazy" 的作品图
       不在此列，避免提前请求废掉懒加载）
       ═══════════════════════════════════════════════════════════════ */
    function preloadPageImages() {
        if (!window.matchMedia('(hover: hover)').matches) return; // 移动端不预载二维码
        var urls = new Set();
        document.querySelectorAll('[data-qr]').forEach(function(el) { urls.add(el.dataset.qr); });
        urls.forEach(function(url) {
            var img = new Image();
            img.referrerPolicy = 'origin';
            img.onerror = function() {}; // 404 时静默忽略，不报控制台错误
            img.src = url;
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       主题切换系统（VitePress appearance 行为）
       - 首次访问跟随系统，点击后固定为浅/深并缓存到 localStorage
       - 之后不再跟随系统，除非清除 localStorage
       ═══════════════════════════════════════════════════════════════ */

    /* 读取操作系统偏好 */
    function getSystemTheme() {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    /* 将主题应用到 DOM：切换 light-mode class、更新 meta 标签、同步滑块 aria-checked */
    function applyTheme(theme) {
        document.documentElement.classList.toggle('light-mode', theme === 'light');
        var themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.content = theme === 'light' ? '#FFFFFF' : '#1E1E1E';
        document.querySelector('meta[name="color-scheme"]').content = theme;
        var sw = document.querySelector('.appearance-switch');
        if (sw) sw.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
    }

    /* 当前生效主题：localStorage 有缓存则用缓存，否则跟随系统（VitePress appearance 行为） */
    function effectiveTheme() {
        var saved = localStorage.getItem('theme');
        if (saved === 'light' || saved === 'dark') return saved;
        var match = document.cookie.match(new RegExp('(?:^|;\\s*)' + THEME_COOKIE + '=(light|dark)'));
        return match ? match[1] : getSystemTheme();
    }

    /* 同步写入跨子域共享 cookie，保证主站/auth/redirect 的深浅模式一致 */
    function saveTheme(theme) {
        localStorage.setItem('theme', theme);
        var secure = location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = THEME_COOKIE + '=' + theme + '; path=/; max-age=' + THEME_COOKIE_MAX_AGE
            + '; SameSite=Lax' + secure + sharedCookieDomain();
    }

    /* 快速切换检测：1 秒内超过 3 次时强制跳 auth.limooo.cn 验证页（验证页自身不参与触发） */
    var THEME_TOGGLE_WINDOW_MS = 1000;
    var THEME_TOGGLE_MAX_COUNT = 3;
    var themeToggleTimes = [];
    var themeChallengeStarted = false;

    function themeChallengeUrl() {
        /* 同域名挑战：在请求来源主机上完成，而不是跳去 auth.<root_domain>。 */
        var base = 'https://' + location.hostname + '/gate';
        var url = new URL(base, location.origin);
        url.searchParams.set('host', location.hostname);
        url.searchParams.set('next', location.pathname + location.search + location.hash);
        url.searchParams.set('challenge', '1');
        return url.toString();
    }

    function rememberThemeToggle(now) {
        var cutoff = now - THEME_TOGGLE_WINDOW_MS;
        themeToggleTimes.push(now);
        while (themeToggleTimes.length && themeToggleTimes[0] <= cutoff) {
            themeToggleTimes.shift();
        }
    }

    function triggerThemeChallenge() {
        var challengeUrl = themeChallengeUrl();
        if (location.hostname === new URL(challengeUrl, location.origin).hostname) return;
        if (themeChallengeStarted) return;
        themeChallengeStarted = true;
        location.replace(challengeUrl);
    }

    /* 点击深浅切换按钮：在浅/深之间切换并缓存，之后不再跟随系统 */
    function toggleTheme() {
        var now = Date.now();
        var next = effectiveTheme() === 'light' ? 'dark' : 'light';
        saveTheme(next);
        applyTheme(next);
        rememberThemeToggle(now);
        if (themeToggleTimes.length > THEME_TOGGLE_MAX_COUNT) {
            triggerThemeChallenge();
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       前端翻译工具
       - I18N:当前语言完整字典(由后端注入,首屏优先)
       - I18N_CACHE:全语言字典缓存,其余语言在页面加载完成后后台预取
       - t():按 key 取文本,支持 {param} 占位符替换
       - applyLang():纯前端切换,重写带 data-i18n 标记的元素,不刷新页面
       ═══════════════════════════════════════════════════════════════ */
    var I18N = JSON.parse(document.body.getAttribute('data-i18n-dict') || '{}');
    var CURRENT_LANG = bodyAttr('data-lang', DEFAULT_LANG);
    var I18N_CACHE = window.I18N_CACHE || {};
    I18N_CACHE[CURRENT_LANG] = I18N;

    function t(key, params) {
        var s = (I18N[key] !== undefined) ? I18N[key] : key;
        if (params) {
            Object.keys(params).forEach(function(k) {
                s = s.split('{' + k + '}').join(params[k]);
            });
        }
        return s;
    }

    /* 取回某语言字典,已缓存则直接回调 */
    function fetchI18n(lang, cb) {
        if (I18N_CACHE[lang] !== undefined) { cb(I18N_CACHE[lang]); return; }
        if (window.__PREVIEW_I18N__) {
            I18N_CACHE[lang] = window.__PREVIEW_I18N__[lang] || null;
            cb(I18N_CACHE[lang]);
            return;
        }
        fetch('/api/i18n/' + encodeURIComponent(lang), { headers: { 'Accept': 'application/json' } })
            .then(function(r) { if (!r.ok) throw new Error('i18n ' + lang); return r.json(); })
            .then(function(d) { I18N_CACHE[lang] = d; cb(d); })
            .catch(function() { I18N_CACHE[lang] = null; cb(null); });
    }

    /* 解析 data-i18n 文本规范:"key" 或 "key;param=val" */
    function parseI18nText(spec) {
        var semi = spec.indexOf(';');
        var key = semi === -1 ? spec : spec.slice(0, semi);
        var params = {};
        if (semi !== -1) {
            spec.slice(semi + 1).split(';').forEach(function(p) {
                var eq = p.indexOf('=');
                if (eq !== -1) params[p.slice(0, eq)] = p.slice(eq + 1);
            });
        }
        return { key: key, params: params };
    }

    /* 解析 data-i18n-attr 规范:"attr1,attr2:key;param=val|attr3:key2" */
    function parseI18nAttr(spec) {
        var out = [];
        String(spec).split('|').forEach(function(seg) {
            var colon = seg.indexOf(':');
            if (colon === -1) return;
            var attrs = seg.slice(0, colon).split(',');
            var rest = seg.slice(colon + 1);
            var semi = rest.indexOf(';');
            var key = semi === -1 ? rest : rest.slice(0, semi);
            var params = {};
            if (semi !== -1) {
                rest.slice(semi + 1).split(';').forEach(function(p) {
                    var eq = p.indexOf('=');
                    if (eq !== -1) params[p.slice(0, eq)] = p.slice(eq + 1);
                });
            }
            attrs.forEach(function(a) { out.push({ attr: a.trim(), key: key, params: params }); });
        });
        return out;
    }

    /* 按当前 I18N 重写所有带标记的元素 */
    function renderI18n() {
        document.querySelectorAll('[data-i18n]').forEach(function(el) {
            var spec = parseI18nText(el.getAttribute('data-i18n'));
            var text = t(spec.key, spec.params);
            var prefix = el.getAttribute('data-i18n-prefix');
            if (prefix != null) text = text ? prefix + text : '';
            el.textContent = text;
        });
        document.querySelectorAll('[data-i18n-attr]').forEach(function(el) {
            parseI18nAttr(el.getAttribute('data-i18n-attr')).forEach(function(x) {
                el.setAttribute(x.attr, t(x.key, x.params));
            });
        });
    }

    /* 写入语言 cookie（名字 / TTL / 共享域都来自构建注入的 data-*） */
    function saveLangCookie(code) {
        var secure = location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = LANG_COOKIE + '=' + code + '; path=/; max-age=' + LANG_COOKIE_MAX_AGE
            + '; SameSite=Lax' + secure + sharedCookieDomain();
    }

    /* 纯前端应用某语言:更新字典/文档 lang/标记文本/菜单选中态 */
    function applyLang(lang) {
        if (I18N_CACHE[lang] == null) {  /* 未缓存或预取失败:先取回再应用 */
            fetchI18n(lang, function(d) {
                if (d) { applyLang(lang); return; }
                /* 字典接口失败时保底:写 cookie 后整页刷新,服务端按新语言渲染 */
                saveLangCookie(lang);
                location.reload();
            });
            return;
        }
        if (lang !== CURRENT_LANG) {
            CURRENT_LANG = lang;
            I18N = I18N_CACHE[lang];
            document.documentElement.lang = lang;
            renderI18n();
            document.querySelectorAll('#langMenu .theme-option').forEach(function(opt) {
                opt.classList.toggle('selected', opt.dataset.lang === lang);
            });
            document.dispatchEvent(new CustomEvent('languagechange'));
        }
        saveLangCookie(lang);
    }

    /* 页面加载完成后,低优先级后台预取其余语言 */
    function prefetchI18n() {
        SUPPORTED_LANGS.forEach(function(lang) {
            if (lang === CURRENT_LANG || I18N_CACHE[lang] != null) return;
            fetchI18n(lang, function() {});
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       跨页预取:当前页加载完成后后台预取另外两个主页(HTML + 图片)
       - HTML 用 <link rel=prefetch> 原生缓存(带 cookie 保持语言一致,
         不支持/不缓存时优雅降级)
       - 图片用 new Image() 预热 HTTP 缓存；主页走 images.limooo.cn
         的静态边缘缓存，联系页二维码继续走 image.limooo.cn Worker
       - 移动端不预取二维码(contact 页二维码仅桌面悬停展示)
       - 图片清单与 index.html / contact.html 的 src 保持同步
       ═══════════════════════════════════════════════════════════════ */
    /* 主页作品图清单由模板按 src/static/portfolio 的实际图片生成
       （body[data-portfolio-thumbs]）；属性缺失时退回默认清单。 */
    var HOME_IMAGES = (document.body && document.body.getAttribute('data-portfolio-thumbs') || '')
        .split(/\s+/).filter(function (rel) { return rel; });
    if (!HOME_IMAGES.length) {
        HOME_IMAGES = [
            '/static/portfolio/thumbs/IMG_0203-640.avif',
            '/static/portfolio/thumbs/IMG_0146-640.avif',
            '/static/portfolio/thumbs/IMG_0130-640.avif',
            '/static/portfolio/thumbs/IMG_0244-640.avif',
            '/static/portfolio/thumbs/IMG_0115-640.avif',
            '/static/portfolio/thumbs/IMG_0179-640.avif' ];
    }
    var PAGE_MANIFEST = {
        '/':        { host: 'limooo.cn',          path: '/',        images: HOME_IMAGES, assetBase: true },
        '/services':{ host: 'services.limooo.cn', path: '/services', images: [] },
        '/contact': { host: 'contact.limooo.cn',  path: '/contact',  images: [
                        '/qr-codes/bilibili.webp',
                        '/qr-codes/qq.webp',
                        '/qr-codes/wechat.webp' ], qr: true, assetBase: false }
    };

    /* 当前所在主页键;生产按子域判断,本地开发按路径 */
    function currentPageKey() {
        var h = location.hostname;
        if (h === 'limooo.cn' || h === 'www.limooo.cn') return '/';
        if (h === 'services.limooo.cn') return '/services';
        if (h === 'contact.limooo.cn') return '/contact';
        if (h.endsWith('.limooo.cn')) return null;   /* admin/apple-account 等管理页不预取 */
        return location.pathname;                    /* 本地开发:'/'|'/services'|'/contact' */
    }

    /* 主页图片直接用 images.limooo.cn/static（静态边缘缓存）；
       二维码仍由 image.limooo.cn Worker 按 Referer 选择水印。 */
    function pageOrigin(key) {
        var manifest = PAGE_MANIFEST[key];
        var attr = manifest && manifest.assetBase
            ? 'data-image-asset-base'
            : 'data-image-watermark-base';
        var base = document.body && document.body.getAttribute(attr);
        return location.hostname.endsWith('limooo.cn')
            ? (base || (manifest && manifest.assetBase
                ? 'https://images.limooo.cn'
                : 'https://image.limooo.cn'))
            : location.origin;
    }

    /* 兄弟页 HTML 地址:生产为子域根(nginx 根即页面),本地为同源 + 路径 */
    function siblingHref(key) {
        var p = PAGE_MANIFEST[key];
        return location.hostname.endsWith('limooo.cn') ? 'https://' + p.host : location.origin + p.path;
    }

    function prefetchPages() {
        var cur = currentPageKey();
        if (!PAGE_MANIFEST[cur]) return;
        var desktop = window.matchMedia('(hover: hover)').matches;
        Object.keys(PAGE_MANIFEST).forEach(function(key) {
            var origin = pageOrigin(key);
            if (key === cur) {
                /* 当前页已在浏览器里；空闲时低优先级预热作品图，
                   用户滚到 #portfolio 时图片尽量已经缓存 */
                if (desktop) {
                    PAGE_MANIFEST[key].images.forEach(function(rel) {
                        var img = new Image();
                        img.referrerPolicy = 'origin';
                        img.fetchPriority = 'low';
                        img.onerror = function() {};
                        img.src = rel.indexOf('http') === 0 ? rel : origin + rel;
                    });
                }
                return;
            }
            var l = document.createElement('link');
            l.rel = 'prefetch'; l.href = siblingHref(key);
            document.head.appendChild(l);
            PAGE_MANIFEST[key].images.forEach(function(rel) {
                if (PAGE_MANIFEST[key].qr && !desktop) return;   /* 移动端跳过二维码 */
                var img = new Image();
                img.referrerPolicy = 'origin';
                img.fetchPriority = 'low';
                img.onerror = function() {};             /* 404 静默,不报控制台错误 */
                img.src = rel.indexOf('http') === 0 ? rel : origin + rel;
            });
        });
    }

    /* ── 语言菜单开关 ── */
    function toggleLangMenu(e) {
        if (e) e.stopPropagation();
        var m = document.getElementById('langMenu');
        if (m) m.classList.toggle('open');
        closeNavMenu();
    }

    function closeLangMenu() {
        var m = document.getElementById('langMenu');
        if (m) m.classList.remove('open');
    }

    function setLang(code) {
        closeLangMenu();
        /* 正常路径：纯前端无刷新切换（fetch 目标字典后替换 data-i18n 节点）。
           仅当字典接口异常时才由 applyLang 的保底分支刷新一次。 */
        if (code !== CURRENT_LANG) applyLang(code);
        else saveLangCookie(code);
    }

    /* 桌面端：语言菜单悬停自动展开/收起（VitePress VPFlyout 行为），触摸端保持点击切换 */
    (function bindLangHover() {
        var fly = document.querySelector('.lang-flyout');
        if (!fly) return;
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            fly.addEventListener('mouseenter', function() {
                var m = document.getElementById('langMenu');
                if (m) m.classList.add('open');
            });
            fly.addEventListener('mouseleave', closeLangMenu);
        }
    })();

    /* ── 导航菜单切换 ── */
    function toggleMobileMenu(e) {
        if (e) e.stopPropagation();
        document.getElementById('navLinksDropdown').classList.toggle('open');
        closeLangMenu();
    }

    /* 关闭导航菜单 */
    function closeNavMenu() {
        document.getElementById('navLinksDropdown').classList.remove('open');
    }

    /* 导航跳转 + 高亮 */
    function navigateTo(url) {
        closeNavMenu();
        location.href = url;
    }

    function openNewWindow(url) {
        window.open(url, "_blank", "noopener");
    }

    /* ── DOM 加载完毕后初始化 ── */
    window.addEventListener('load', function() {
        preloadPageImages();

        /* 恢复主题：有缓存用缓存，无缓存跟随系统（VitePress appearance 行为） */
        applyTheme(effectiveTheme());


        /* 系统主题变化时：仅在无缓存（跟随系统）状态下自动跟随 */
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
            if (!localStorage.getItem('theme')) applyTheme(getSystemTheme());
        });

        /* 点击 .theme-toggle 外部时收起所有菜单 */
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.theme-toggle')) {
                closeNavMenu();
                closeLangMenu();
            }
        });


        /* 界面加载完成后立即预取全部语言:切换语言时字典已在缓存,不再等网络;
           另外两个主页的 prefetch 保持低优先级,不抢首屏之后的带宽 */
        prefetchI18n();
        if ('requestIdleCallback' in window) {
            requestIdleCallback(prefetchPages, { timeout: 3000 });
        } else {
            setTimeout(prefetchPages, 1500);
        }
    });
