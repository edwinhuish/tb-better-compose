/**
 * 写信增强 BetterCompose — 选项页
 *
 * 这一页现在内嵌在附加组件管理器里（manifest 的 options_ui.open_in_tab = false），
 * 点「设置」不再跳新标签页，所有配置项就在当前这一页里改完。
 *
 * 四条原则：
 *   1. 配置的默认值与校验规则不在这里重写 —— 全部取 compose/config.js，
 *      否则「选项页说没问题、编辑器里按钮却没了」这种分歧迟早出现。
 *   2. 只有和默认值**不同**的键才写进 storage（CC.diff）。默认块格式的名字是
 *      跟着界面语言翻的，全量保存会把当时那门语言的名字冻住。
 *   3. 语言是一切的前提：先读出用户选的语言，再加载文案，最后才渲染界面。
 *      改语言时整页重渲染，而不是留下半页旧语言。
 *   4. 「有没有未保存的改动」不靠一个 dirty 标志手工维护 —— 直接拿当前表单
 *      normalize 出来的 patch 与已落盘的那份比。任何一条漏掉 touch() 的改动
 *      路径都不会让它失准。
 */

'use strict';

(async () => {
  const CC = window.__tcsConfig;
  const I18N = window.__tcsI18n;
  const $ = sel => document.querySelector(sel);

  if (!CC || !I18N) {
    // 这两个文件是本页面的全部逻辑来源，缺一个就什么都做不了。
    document.body.textContent =
      'BetterCompose: compose/config.js or compose/i18n.js failed to load.';
    return;
  }

  const store = browser.storage.local;
  const BASE = browser.runtime.getURL('');

  // 内嵌时是 iframe：宿主已经给出扩展名与关闭方式，本页不再画大标题。
  // 跨源只比较引用，读 window.top 的属性才会被拦。
  const embedded = window.top !== window;
  document.documentElement.classList.toggle('embedded', embedded);

  // 语言名用各语言自己的写法：把「Français」翻成「法语…」只对中文用户友好，
  // 而语言选择器本来就是给「看不懂当前界面语言」的人准备的。
  const LANG_NAMES = {
    en: 'English', zh_CN: '简体中文', zh_TW: '繁體中文', ja: '日本語',
    de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский',
  };

  // token → 文案键，来自 config.js 的按钮分组表（选项页不自己维护第二份）
  const BUTTON_KEY = new Map();
  CC.BUTTON_GROUPS.forEach(group => group.items.forEach(([token, key]) => {
    if (!BUTTON_KEY.has(token)) BUTTON_KEY.set(token, key);
  }));

  // ── 1. 语言与文案 ───────────────────────────────────────────────────────
  let savedRaw = {};
  try {
    const got = await store.get(CC.CONFIG_KEY);
    savedRaw = (got && got[CC.CONFIG_KEY]) || {};
  } catch (e) {
    console.error('[BetterCompose] 读配置失败，按默认值显示:', e);
  }

  let i18n = await I18N.load(BASE, savedRaw.language);
  let t = i18n.t;
  let cfg = CC.normalize(savedRaw, t);

  // 用户有没有动过段落格式那一栏。没动过的话，换语言时默认名字要跟着重翻，
  // 动过就原样保留 —— 那是他自己写的名字。
  let blocksTouched = false;

  // 已落盘的 patch 序列化结果。CC.diff 的输出键序固定，所以字符串比较足够，
  // 而且比逐键比更省事：以后 config.js 加一个键，这里不用跟着改。
  let savedKey = JSON.stringify(CC.diff(cfg, t));
  let statusKind = '';

  const applyLangAttr = () => { document.documentElement.lang = i18n.locale.replace('_', '-'); };
  applyLangAttr();

  function translateStatic() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
  }

  function setStatus(text, kind) {
    statusKind = kind || '';
    const el = $('#status');
    el.textContent = text || '';
    el.className = 'status' + (statusKind ? ' ' + statusKind : '');
  }

  const showWarn = (el, text) => {
    el.textContent = text || '';
    el.hidden = !text;
  };

  // ── 2. 未保存的改动 ─────────────────────────────────────────────────────
  const patchKey = () => JSON.stringify(CC.diff(cfg, t));
  const isDirty = () => patchKey() !== savedKey;

  // 改动的唯一收口：重算 dirty、更新按钮可用性、必要时把状态改成「未保存」。
  // 任何一个改配置的地方都必须走这里 —— 包括换语言（它也算改动）。
  function touch() {
    const dirty = isDirty();
    $('#save').disabled = !dirty;
    $('#cancel').disabled = !dirty;
    if (dirty) setStatus(t('status_dirty'), 'dirty');
    else if (statusKind === 'dirty') setStatus('');
    return dirty;
  }

  // ── 3. 确认框 ───────────────────────────────────────────────────────────
  // 不用 window.confirm：内嵌在 chrome 页面里时它的样式与宿主对不上，
  // 个别嵌入上下文还会把模态直接吞掉。
  //
  // 结论也从按钮的点击直接取，不依赖 <dialog> 的 close 事件 —— 那个事件在
  // 「表单 method=dialog 提交」这条路径上是异步排队的，实测在无头环境里会
  // 干脆不出现；一旦它不出现，await 就永远悬着，用户点了「确定」什么都不会
  // 发生。按钮回调是同步的，稳。
  const dlg = $('#confirm-dialog');
  function askConfirm(text) {
    if (dlg.open) return Promise.resolve(false);   // 连点两下时别让 showModal 抛
    $('#confirm-text').textContent = text;
    return new Promise(resolve => {
      const finish = answer => {
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(answer);
      };
      const onClick = ev => {
        const btn = ev.target.closest('button[data-answer]');
        if (btn) finish(btn.getAttribute('data-answer') === 'ok');
      };
      const onCancel = () => finish(false);        // Esc 等同于「取消」
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
    });
  }

  // ── 4. 工具栏 chips ─────────────────────────────────────────────────────
  const label = token =>
    token === '|' ? '|' : (BUTTON_KEY.has(token) ? t(BUTTON_KEY.get(token)) : token);

  function iconButton(glyph, title, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderChips() {
    const box = $('#chips');
    box.textContent = '';
    cfg.toolbar.forEach((token, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (token === '|' ? ' sep' : '');

      const text = document.createElement('span');
      text.className = 'chip-label';
      text.textContent = label(token);
      if (token !== '|' && !BUTTON_KEY.has(token)) text.title = token;  // 手写进来的冷门按钮
      chip.appendChild(text);

      chip.appendChild(iconButton('←', 'move', () => moveToken(i, -1), i === 0));
      chip.appendChild(iconButton('→', 'move', () => moveToken(i, 1), i === cfg.toolbar.length - 1));
      chip.appendChild(iconButton('✕', 'remove', () => {
        cfg.toolbar.splice(i, 1);
        renderChips();
        touch();
      }));

      box.appendChild(chip);
    });
    $('#chips-empty').hidden = cfg.toolbar.length > 0;

    // 手写进 storage 的冷门按钮（或拼错的）不在分组表里，界面上只能给出原始
    // token。这里把它们列出来 —— 编辑器那边会静默丢弃未注册的 token，
    // 不提示的话表现就是「加了个按钮，但工具栏上什么也没多」。
    const unknown = cfg.toolbar.filter(tok => tok !== '|' && !BUTTON_KEY.has(tok));
    showWarn($('#chips-warn'),
      unknown.length ? t('opt_toolbar_unknown', [unknown.join(', ')]) : '');
  }

  function moveToken(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= cfg.toolbar.length) return;
    const [token] = cfg.toolbar.splice(i, 1);
    cfg.toolbar.splice(j, 0, token);
    renderChips();
    touch();
  }

  function renderAddSelect() {
    const sel = $('#add-button');
    sel.textContent = '';

    const head = document.createElement('option');
    head.value = '';
    head.textContent = t('opt_toolbar_add');
    sel.appendChild(head);

    CC.BUTTON_GROUPS.forEach(group => {
      const og = document.createElement('optgroup');
      og.label = t(group.title);
      group.items.forEach(([token, key]) => {
        const opt = document.createElement('option');
        opt.value = token;
        opt.textContent = t(key);
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    sel.value = '';
  }

  // ── 5. 段落格式 ─────────────────────────────────────────────────────────
  function readBlocks() {
    const pairs = [];
    const bad = [];
    $('#blocks').value.split('\n').forEach(line => {
      const s = line.trim();
      if (!s) return;
      const at = s.indexOf('=');
      if (at < 0) { bad.push(s); return; }
      const name = s.slice(0, at).trim();
      const tag = s.slice(at + 1).trim().toLowerCase();
      if (!name || !CC.BLOCK_TAGS.includes(tag)) { bad.push(tag || s); return; }
      pairs.push([name, tag]);
    });
    return { pairs, bad };
  }

  function renderBlocks() {
    $('#blocks').value = cfg.blockFormats.map(([name, tag]) => name + '=' + tag).join('\n');
    showWarn($('#blocks-warn'), '');
    renderDefaultSelect();
  }

  function renderDefaultSelect() {
    const sel = $('#default-block');
    sel.textContent = '';
    const seen = new Set();
    cfg.blockFormats.forEach(([name, tag]) => {
      if (seen.has(tag)) return;
      seen.add(tag);
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (!seen.has(cfg.defaultBlockFormat) && cfg.blockFormats.length) {
      cfg.defaultBlockFormat = cfg.blockFormats[0][1];
    }
    sel.value = cfg.defaultBlockFormat;
  }

  // ── 6. 语言 ─────────────────────────────────────────────────────────────
  function renderLanguages() {
    const sel = $('#language');
    sel.textContent = '';

    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('opt_language_auto');
    sel.appendChild(auto);

    CC.LANGUAGES.filter(code => code !== 'auto').forEach(code => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = LANG_NAMES[code] || code;
      sel.appendChild(opt);
    });

    sel.value = cfg.language;
  }

  // 换语言要整页重渲染：文案、chips 里的按钮名、下拉里的分组名都变了。
  async function switchLanguage(code) {
    cfg.language = code;
    i18n = await I18N.load(BASE, code);
    t = i18n.t;
    applyLangAttr();
    translateStatic();

    // 没动过段落格式的人，默认名字应当跟着语言走；动过的人保留自己的写法。
    if (!blocksTouched) {
      cfg.blockFormats = CC.parseBlockFormats(CC.defaults(t).blockFormats, t);
    }

    renderAll();
    touch();
  }

  // ── 7. 原始配置 ─────────────────────────────────────────────────────────
  function renderRaw() {
    const empty = !savedRaw || !Object.keys(savedRaw).length;
    $('#raw').textContent = empty ? t('opt_empty') : JSON.stringify(savedRaw, null, 2);
  }

  function syncControls() {
    $('#markdown').checked = !!cfg.markdownPaste;
    $('#debug').checked = !!cfg.debug;
  }

  function renderAll() {
    renderChips();
    renderAddSelect();
    renderBlocks();
    renderLanguages();
    syncControls();
    renderRaw();
  }

  // ── 8. 保存 / 取消 / 恢复默认 ───────────────────────────────────────────
  async function save() {
    if (!isDirty()) {
      setStatus(t('status_unchanged'));
      return;
    }
    const patch = CC.diff(cfg, t);
    try {
      await store.set({ [CC.CONFIG_KEY]: patch });
      savedRaw = patch;
      savedKey = JSON.stringify(patch);
      renderRaw();
      touch();
      setStatus(Object.keys(patch).length ? t('status_saved') : t('status_unchanged'), 'ok');
    } catch (e) {
      console.error('[BetterCompose] 保存失败:', e);
      setStatus(t('status_error', [(e && e.message) || e]), 'err');
    }
  }

  // 取消 = 丢掉表单上的改动，回到 storage 里那一份。语言也要退回去，
  // 否则界面还停在新语言、默认块名却按旧语言算，patch 会莫名其妙对不上。
  async function cancel() {
    if (!isDirty()) return;
    if (!(await askConfirm(t('confirm_discard')))) return;

    i18n = await I18N.load(BASE, savedRaw.language);
    t = i18n.t;
    applyLangAttr();
    translateStatic();

    cfg = CC.normalize(savedRaw, t);
    blocksTouched = false;
    renderAll();
    setStatus('');
    touch();
  }

  async function restoreDefaults() {
    if (!(await askConfirm(t('confirm_reset')))) return;
    cfg = CC.normalize(null, t);
    blocksTouched = false;
    renderAll();
    // 恢复默认按「立即生效」处理：只重置不落盘的话，用户离开这一页时
    // 会以为已经恢复了，实际什么都没发生。
    await save();
  }

  // ── 9. 事件 ─────────────────────────────────────────────────────────────
  $('#add-button').addEventListener('change', ev => {
    const token = ev.target.value;
    if (!token) return;
    cfg.toolbar.push(token);
    renderChips();
    ev.target.value = '';
    touch();
  });

  $('#add-separator').addEventListener('click', () => {
    cfg.toolbar.push('|');
    renderChips();
    touch();
  });

  $('#reset-toolbar').addEventListener('click', () => {
    cfg.toolbar = CC.normalizeToolbar(CC.TOOLBAR_DEFAULT);
    renderChips();
    touch();
  });

  $('#blocks').addEventListener('input', () => {
    blocksTouched = true;
    const { pairs, bad } = readBlocks();
    // 一行都没有（或全错）时不要拿空数组覆盖：保存时 CC.normalize 会回退默认，
    // 但界面上先保持原样，让人能看见自己写了什么。
    if (pairs.length) cfg.blockFormats = pairs;
    showWarn($('#blocks-warn'), bad.length ? t('opt_block_invalid', [bad.join(', ')]) : '');
    renderDefaultSelect();
    touch();
  });

  $('#default-block').addEventListener('change', ev => {
    cfg.defaultBlockFormat = ev.target.value;
    touch();
  });

  $('#markdown').addEventListener('change', ev => {
    cfg.markdownPaste = ev.target.checked;
    touch();
  });

  $('#debug').addEventListener('change', ev => {
    cfg.debug = ev.target.checked;
    touch();
  });

  $('#language').addEventListener('change', ev => switchLanguage(ev.target.value));

  $('#save').addEventListener('click', save);
  $('#cancel').addEventListener('click', cancel);
  $('#restore').addEventListener('click', restoreDefaults);

  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save();
    }
  });

  // 关页面/切到别的附加组件时兜底。顶层的标签页会弹出原生确认；内嵌 iframe
  // 被宿主直接卸掉时这个事件不保证执行 —— 所以真正的保障是下面那行状态提示
  // 与「保存」按钮的可用状态，别指望用户会看到浏览器弹窗。
  window.addEventListener('beforeunload', ev => {
    if (!isDirty()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  // ── 10. 首次渲染 ────────────────────────────────────────────────────────
  translateStatic();
  renderAll();
  touch();          // 刚打开时没有改动：保存/取消都是灰的
})();
