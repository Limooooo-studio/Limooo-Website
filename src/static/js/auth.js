/** 门禁页前端交互：运行时从 /gate/config 获取 sitekey 与 i18n。 */

var turnstileWidget = null;
var CONFIG = null;
var GATE_I18N = {};
var TURNSTILE_SITEKEY = "";
/* 契约事实由 build.py 注入 <body data-*>（模板 _lang_attrs.html），这里只读。 */
function gateBodyAttr(name, fallback) {
  var value = document.body && document.body.getAttribute(name);
  return value === null || value === undefined || value === '' ? (fallback || '') : value;
}
var DEFAULT_LANG = gateBodyAttr('data-default-lang', 'en-us');
var ROOT_DOMAIN = gateBodyAttr('data-root-domain', 'limooo.cn');
var LANG_COOKIE = gateBodyAttr('data-lang-cookie', 'user_lang_preference');
var LANG_COOKIE_MAX_AGE = gateBodyAttr('data-lang-cookie-max-age', '31536000');
var THEME_COOKIE = gateBodyAttr('data-theme-cookie', 'limooo_theme');
var THEME_COOKIE_MAX_AGE = gateBodyAttr('data-theme-cookie-max-age', '31536000');
function sharedCookieDomain() {
  return location.hostname === ROOT_DOMAIN || location.hostname.endsWith('.' + ROOT_DOMAIN)
    ? '; domain=.' + ROOT_DOMAIN
    : '';
}
var CURRENT_LANG = gateBodyAttr('data-lang', DEFAULT_LANG);
var gateVerificationInFlight = false;
document.documentElement.lang = CURRENT_LANG;

/* 构建时把 4 种语言的 gate 文案内联到 HTML；/gate/config 仅用于补 sitekey，
   即使运行时配置接口暂时不可用，语言切换和首屏文案也不会变成 key 占位符。 */
(function () {
  var el = document.getElementById('gate-i18n');
  if (!el) return;
  try {
    GATE_I18N = JSON.parse(el.textContent || '{}');
  } catch (e) {
    console.warn('gate i18n parse failed', e);
  }
})();

function t(key) {
  var dict = GATE_I18N[CURRENT_LANG] || GATE_I18N[DEFAULT_LANG] || {};
  return dict[key] !== undefined ? dict[key] : key;
}

function turnstileLang(code) {
  return { 'zh-cn': 'zh-cn', 'en-us': 'en-us', 'ja-jp': 'ja', 'ko-kr': 'ko' }[code] || 'auto';
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function effectiveTheme() {
  var saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  var match = document.cookie.match(new RegExp('(?:^|;\\s*)' + THEME_COOKIE + '=(light|dark)'));
  return match ? match[1] : getSystemTheme();
}

function saveTheme(theme) {
  localStorage.setItem('theme', theme);
  var secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = THEME_COOKIE + '=' + theme + '; path=/; max-age=' + THEME_COOKIE_MAX_AGE
    + '; SameSite=Lax' + secure + sharedCookieDomain();
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('light-mode', theme === 'light');
  var schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.content = theme;
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = theme === 'light' ? '#FFFFFF' : '#1E1E1E';
  var sw = document.querySelector('.appearance-switch');
  if (sw) sw.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
}

function loadTurnstileScript() {
  if (window.turnstile || TURNSTILE_SITEKEY === '') return;
  if (document.querySelector('script[data-turnstile]')) return;
  var s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
  s.async = true;
  s.defer = true;
  s.setAttribute('data-turnstile', '');
  document.head.appendChild(s);
}

function showError(key) {
  var el = document.getElementById('gate-error');
  var blockedDetail = document.getElementById('gate-blocked-detail');
  var locationLabel = document.getElementById('diag-location-label');
  var country = document.getElementById('diag-country');
  if (!el) return;
  if (!key) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('blocked');
    if (blockedDetail) blockedDetail.hidden = true;
    if (locationLabel) locationLabel.hidden = false;
    if (country) country.hidden = false;
    var retryBtn = document.getElementById('gate-retry');
    if (retryBtn) retryBtn.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = t('error_' + key);
  var blocked = key === 'blocked';
  el.classList.toggle('blocked', blocked);
  if (blockedDetail) blockedDetail.hidden = !blocked;
  if (locationLabel) locationLabel.hidden = blocked;
  if (country) country.hidden = blocked;
}

/* 把文案中的品牌词（如 "Limooo"）包成 Baloo 2 字体的 span，语言变体同样生效。 */
function brandifyText(el) {
  var word = el.getAttribute('data-brandify');
  if (!word || !el.textContent || el.textContent.indexOf(word) === -1) return;
  if (el.querySelector('.brand-word')) return;
  el.innerHTML = el.textContent.split(word).join('<span class="brand-word">' + word + '</span>');
}

function resetTurnstile() {
  var wrap = document.getElementById('turnstile-wrap');
  if (!wrap) return;
  if (!window.turnstile) {
    loadTurnstileScript();
    return;
  }
  showError('');
  if (turnstileWidget) {
    window.turnstile.remove(turnstileWidget);
    turnstileWidget = null;
  }
  /* 失败后绝不自动 reset：Turnstile 重置后会立即自行重新求解并再次触发
     callback，形成"失败→reset→自动求解→再失败"的无人值守死循环（表现为
     一直卡在人机验证）。重新求解只由用户主动重试或切换语言/主题触发。 */
  turnstileWidget = window.turnstile.render(wrap, {
    sitekey: TURNSTILE_SITEKEY,
    callback: submitGateVerification,
    'error-callback': function () {
      showError('failed');
      return true; /* 阻止 Turnstile 自行重试，交给用户手动重试 */
    },
    'expired-callback': function () { showError('failed'); },
    theme: effectiveTheme() === 'light' ? 'light' : 'dark',
    language: turnstileLang(CURRENT_LANG)
  });
}

/* 用户显式重试：清空上一次的错误并按需重新求解。 */
function retryGateVerification() {
  if (gateVerificationInFlight) return;
  showError('');
  if (window.turnstile && turnstileWidget) {
    window.turnstile.reset(turnstileWidget);
    return;
  }
  resetTurnstile();
}

/* 验证在当前门禁页完成：接口只返回 Set-Cookie，不再跳转到 redirect 子域。 */
function submitGateVerification() {
  var form = document.getElementById('gate');
  if (!form || gateVerificationInFlight) return;
  gateVerificationInFlight = true;

  fetch(form.action, {
    method: 'POST',
    body: new FormData(form),
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json' }
  })
    .then(function (response) {
      if (response.ok) {
        var next = form.querySelector('input[name="next"]');
        /* 当前页面直接进入原目标，不走 redirect.limooo.cn 中转页。 */
        location.replace(next && next.value ? next.value : '/');
        return null;
      }
      return response.json().catch(function () { return { error: 'failed' }; });
    })
    .then(function (result) {
      if (!result) return;
      showError(result.error || 'failed');
      showRetry();
      /* 关键：这里不 reset()。Turnstile 重置后会立即自行重新求解并再次触发
         callback，形成"失败→reset→自动求解→再失败"的无声死循环。 */
    })
    .catch(function () {
      showError('unavailable');
      showRetry();
    })
    .then(function () { gateVerificationInFlight = false; });
}

/* 失败后给出显式的"重试"入口，用户点了才重新求解，避免自动死循环。 */
function showRetry() {
  var form = document.getElementById('gate');
  if (!form) return;
  var btn = document.getElementById('gate-retry');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'gate-retry';
    btn.type = 'button';
    btn.className = 'gate-retry';
    btn.setAttribute('data-action', 'retryGateVerification');
    form.appendChild(btn);
  }
  btn.textContent = t('retry');
  btn.hidden = false;
}

document.addEventListener('submit', function (event) {
  if (event.target && event.target.id === 'gate') {
    event.preventDefault();
    submitGateVerification();
  }
});

function renderI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var text = t(el.getAttribute('data-i18n'));
    var key = el.getAttribute('data-i18n');
    if (text === key) return; /* 字典尚未加载时保留服务端静态文案 */
    var prefix = el.getAttribute('data-i18n-prefix');
    if (prefix != null) text = text ? prefix + text : '';
    el.textContent = text;
    brandifyText(el);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
    var text = t(el.getAttribute('data-i18n-html'));
    if (text !== el.getAttribute('data-i18n-html')) el.innerHTML = text;
  });
  document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
    el.getAttribute('data-i18n-attr').split('|').forEach(function (seg) {
      var colon = seg.indexOf(':');
      if (colon === -1) return;
      var key = seg.slice(colon + 1).split(';')[0];
      seg.slice(0, colon).split(',').forEach(function (attr) {
        var value = t(key);
        if (value !== key) el.setAttribute(attr.trim(), value);
      });
    });
  });
}

function saveLangCookie(code) {
  /* 根域名由 /gate/config 与 <body data-root-domain> 两处提供，优先取运行时配置。 */
  var rootDomain = (CONFIG && CONFIG.root_domain) || ROOT_DOMAIN;
  var domain = rootDomain && (location.hostname === rootDomain || location.hostname.endsWith('.' + rootDomain))
    ? '; domain=.' + rootDomain
    : '';
  var secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = LANG_COOKIE + '=' + code + '; path=/; max-age=' + LANG_COOKIE_MAX_AGE
    + '; SameSite=Lax' + secure + domain;
}

function fetchI18n(lang, cb) {
  if (GATE_I18N[lang]) { cb(GATE_I18N[lang]); return; }
  fetch('/api/i18n/' + encodeURIComponent(lang), { headers: { 'Accept': 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d) {
        /* /api/i18n/<lang> 返回的是完整 locale 字典，字段名带 gate_ 前缀；
           这里只补门禁页需要的键，避免后续 renderI18n 重写失败。 */
        var map = {
          title: 'gate_title', heading: 'gate_heading', location: 'gate_location',
          ip: 'gate_ip', ray: 'gate_ray', foot: 'gate_foot',
          lang_aria: 'gate_lang_aria', theme_aria: 'gate_theme_aria',
          footer_rights: 'footer_rights', footer_source: 'footer_source', footer_source_link: 'footer_source_link',
          error_sitekey: 'gate_error_sitekey', error_invalid: 'gate_error_invalid',
          error_unavailable: 'gate_error_unavailable', error_failed: 'gate_error_failed',
          error_blocked: 'gate_error_blocked', error_blocked_detail: 'gate_error_blocked_detail'
        };
        var normalized = {};
        Object.keys(map).forEach(function (outKey) {
          var srcKey = map[outKey];
          if (d[srcKey] !== undefined) normalized[outKey] = d[srcKey];
        });
        GATE_I18N[lang] = Object.keys(normalized).length ? normalized : GATE_I18N[lang];
      }
      cb(GATE_I18N[lang] || null);
    })
    .catch(function () { cb(null); });
}

function applyLang(lang) {
  if (!GATE_I18N[lang]) {
    fetchI18n(lang, function (d) {
      if (!d) {
        saveLangCookie(lang);
        location.reload(); /* 字典接口也不可用时，回退到服务端按 cookie 渲染新语言 */
        return;
      }
      applyLang(lang);
    });
    return;
  }
  if (lang !== CURRENT_LANG) {
    CURRENT_LANG = lang;
    document.documentElement.lang = lang;
    renderI18n();
    document.querySelectorAll('#langMenu .theme-option').forEach(function (opt) {
      opt.classList.toggle('selected', opt.dataset.lang === lang);
    });
  }
  saveLangCookie(lang);
  resetTurnstile();
}

function toggleLangMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('langMenu');
  if (m) m.classList.toggle('open');
}

function closeLangMenu() {
  var m = document.getElementById('langMenu');
  if (m) m.classList.remove('open');
}

function setLang(code) {
  closeLangMenu();
  applyLang(code);
}

function toggleTheme() {
  var next = effectiveTheme() === 'light' ? 'dark' : 'light';
  saveTheme(next);
  applyTheme(next);
  resetTurnstile();
}

function onloadTurnstileCallback() {
  resetTurnstile();
}

function initGateConfig(cfg) {
  CONFIG = cfg;
  GATE_I18N = cfg.i18n || GATE_I18N;
  TURNSTILE_SITEKEY = cfg.sitekey || '';
  CURRENT_LANG = cfg.lang || CURRENT_LANG;
  document.documentElement.lang = CURRENT_LANG;
  applyTheme(effectiveTheme());
  renderI18n();
  var errorKey = document.body.getAttribute('data-gate-error') || '';
  if (errorKey) showError(errorKey);
  if (errorKey === 'blocked') {
    var form = document.getElementById('gate');
    if (form) form.hidden = true;
    return;
  }
  if (TURNSTILE_SITEKEY === '') {
    showError('sitekey');
    return;
  }
  resetTurnstile();
}

(function bindLangHover() {
  var fly = document.querySelector('.lang-flyout');
  if (!fly) return;
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    fly.addEventListener('mouseenter', function () {
      var m = document.getElementById('langMenu');
      if (m) m.classList.add('open');
    });
    fly.addEventListener('mouseleave', closeLangMenu);
  }
})();

document.addEventListener('click', function (e) {
  if (!e.target.closest('.theme-toggle')) closeLangMenu();
});

/* 页面静态文案先按构建语言渲染；运行时加载配置后补齐 Turnstile 与切换能力。 */
applyTheme(effectiveTheme());
renderI18n();
/* i18n 不可用时的静态回退也保留品牌字 Baloo 2 渲染。 */
var staticBrandTarget = document.querySelector('[data-brandify]');
if (staticBrandTarget) brandifyText(staticBrandTarget);
showError(document.body.getAttribute('data-gate-error') || '');

fetch('/gate/config', { headers: { 'Accept': 'application/json' } })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (cfg) { if (cfg) initGateConfig(cfg); })
  .catch(function () { showError('unavailable'); });

fetch('/gate/diag', { headers: { 'Accept': 'application/json' } })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (d) {
    if (!d) return;
    var map = { 'diag-country': d.country, 'diag-ip': d.ip, 'diag-ray': d.ray };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && map[id]) el.textContent = map[id];
    });
  })
  .catch(function () {});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
  if (!localStorage.getItem('theme')) applyTheme(getSystemTheme());
});
