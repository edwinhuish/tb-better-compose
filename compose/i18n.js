/**
 * 写信增强 BetterCompose — 极小的 i18n 运行时
 *
 * 为什么不用 browser.i18n.getMessage：
 *   1. 它只认浏览器自己的语言，而选项页允许用户手动指定界面语言（'auto' 之外
 *      的值），那就得按用户选的那门语言取文案，getMessage 做不到；
 *   2. 撰写窗口是 compose script，可用 API 面比普通页面窄，getMessage 未必在；
 *   3. 文案表是普通 JSON，用 fetch 取回来在 node 里也能测。
 *
 * 直接复用 WebExtension 的 _locales 布局与条目格式（{"key": {"message": "…"}}），
 * 于是同一批文件同时喂给 manifest 的 __MSG_*__ 替换与这里，不需要维护两套文案。
 *
 * 占位符只支持 $1…$9（够用，且不用在 JSON 里再写一份 placeholders 声明）。
 * 查不到的键原样返回键名 —— 界面上会看到一个 block_body 之类的字样，
 * 但不会崩，也不会让撰写窗口卡住。
 */

(function (root) {
  'use strict';

  // 必须与 compose/config.js 的 LANGUAGES（去掉 'auto'）一致，
  // 也必须与 _locales/ 下的目录名、vendor/tinymce/langs/<code>.js 一致。
  // tools/check-i18n.mjs 会把这三处对一遍。
  const SUPPORTED = ['en', 'zh_CN', 'zh_TW', 'ja', 'de', 'fr', 'es', 'ru'];
  const FALLBACK = 'en';

  // Thunderbird / 浏览器给的是 BCP 47（zh-CN、zh-Hant、de-AT），
  // _locales 的目录名是下划线形式（zh_CN）。这里做一次归一。
  const EXPLICIT = {
    zh: 'zh_CN',
    zh_cn: 'zh_CN', zh_sg: 'zh_CN', zh_hans: 'zh_CN', zh_hans_cn: 'zh_CN',
    zh_tw: 'zh_TW', zh_hk: 'zh_TW', zh_mo: 'zh_TW', zh_hant: 'zh_TW',
  };

  // 逐段缩短地试：zh-Hant-TW → zh_hant_tw / zh_hant / zh。这样
  // 「繁体 + 地区」「德语 + 国家」这类都能落到支持的那一档，而不是掉回英文。
  const canonical = code => {
    const lower = String(code || '').trim().toLowerCase().replace(/-/g, '_');
    if (!lower) return '';
    const parts = lower.split('_');
    for (let i = parts.length; i > 0; i--) {
      const probe = parts.slice(0, i).join('_');
      if (EXPLICIT[probe]) return EXPLICIT[probe];
      const hit = SUPPORTED.find(c => c.toLowerCase() === probe);
      if (hit) return hit;
    }
    return '';
  };

  // requested 是配置里的值（'auto' 或具体语言），browserLocale 是系统给的。
  // 无论怎么绕，返回值一定落在 SUPPORTED 里 —— 调用方不用再判空。
  function resolveLocale(requested, browserLocale) {
    const want = String(requested == null ? '' : requested).trim();
    if (want && want !== 'auto') {
      const hit = canonical(want);
      if (hit) return hit;
      // 配置里写了个不支持的值：配置层已经回退过 auto，这里再兜一次
    }
    return canonical(browserLocale) || FALLBACK;
  }

  function detectLocale() {
    try {
      const i18n = root.browser && root.browser.i18n;
      if (i18n && typeof i18n.getUILanguage === 'function') {
        const lang = i18n.getUILanguage();
        if (lang) return lang;
      }
    } catch (e) { /* compose script 里可能没有这个 API */ }
    return (root.navigator && root.navigator.language) || FALLBACK;
  }

  // $1…$9 替换。subs 里没有的位号原样留着（$2 显示成 $2），
  // 好过悄悄换成空串 —— 那样看不出是文案写错了还是参数没传。
  function format(text, subs) {
    if (!subs || !subs.length) return text;
    return String(text).replace(/\$(\d)/g, (whole, digit) => {
      const i = Number(digit) - 1;
      return i >= 0 && i < subs.length ? String(subs[i]) : whole;
    });
  }

  function buildT(messages) {
    const table = (messages && typeof messages === 'object') ? messages : {};
    return function t(key, subs) {
      const entry = table[key];
      const text = entry && typeof entry === 'object' ? entry.message : entry;
      if (typeof text !== 'string' || !text) return key;
      return format(text, subs);
    };
  }

  const defaultFetcher = url => {
    try {
      return fetch(url).then(res => (res && res.ok ? res.json() : null)).catch(() => null);
    } catch (e) {
      return Promise.resolve(null);
    }
  };

  // 读 _locales/<locale>/messages.json。取不到就退到英文，英文也取不到就
  // 退成「键名即文案」—— 编辑器照常初始化，只是文案不好看。
  async function load(base, requested, fetcher) {
    const getJson = typeof fetcher === 'function' ? fetcher : defaultFetcher;
    const root_ = base && base.endsWith('/') ? base : String(base || '') + '/';
    const locale = resolveLocale(requested, detectLocale());
    const url = loc => root_ + '_locales/' + loc + '/messages.json';

    let messages = await getJson(url(locale));
    if (messages) return { locale, messages, t: buildT(messages) };

    if (locale !== FALLBACK) {
      messages = await getJson(url(FALLBACK));
      if (messages) {
        return { locale: FALLBACK, messages, t: buildT(messages), fallbackFrom: locale };
      }
    }
    return { locale: FALLBACK, messages: {}, t: buildT({}), missing: true };
  }

  root.__tcsI18n = { SUPPORTED, FALLBACK, resolveLocale, detectLocale, format, buildT, load };
})(typeof window !== 'undefined' ? window : globalThis);
