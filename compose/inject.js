/**
 * 写信增强 BetterCompose — compose script
 *
 * 注入环境：about:blank?compose（撰写窗口的正文文档，content script 隔离世界）
 *
 * 注入策略沿用 Thunderpen 的结论：CSP 不允许 <script src="moz-extension://…">，
 * 所以 TinyMCE 只能 fetch + 间接 eval；它内部加载 plugin/theme/lang 的
 * ScriptLoader.loadScript 也要一并改写成 fetch+eval。
 *
 * 相对 Thunderpen 的三处改动：
 *   1. 工具栏单行（menubar 关掉、toolbar_mode=sliding）
 *   2. 左侧一组折叠菜单（menubutton），常用按钮排在后面
 *   3. 图片按 Thunderbird 自己的规则打 moz-do-not-send 标记，让 TB 的发送管线
 *      决定「收进 MIME 部件」还是「保留远程引用」，而不是无脑塞 base64
 */

'use strict';

// 最外层 catch 用：i18n 加载成功后指向真正的翻译函数，之前是 null。
// 需要写成脚本级变量，因为它要跨出下面那个 IIFE 的作用域 —— 主流程中途抛错时
// 往往正是 i18n / 配置加载那一步出的问题，那时 `t` 根本不存在。
let __tcsSay = null;

(async function () {
  const BASE = browser.runtime.getURL('vendor/tinymce');
  const SYNC_MS = 500;

  // 诊断日志默认关（选项页「诊断日志」可以打开）。它原先无条件输出，
  // 一个每天开几十个撰写窗口的人，控制台会被 [BetterCompose] 刷满。
  // 预警与报错不在此列 —— 那些任何时候都该看得见。
  let DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('[BetterCompose]', ...a); };

  // 声明放在最前：下面的 body 守卫可能在 TinyMCE 还没加载完时就被 mutation 叫醒，
  // 提前声明才不会有 let 的暂时性死区。
  let tmce;

  if (window.__tcsStarted) return;
  window.__tcsStarted = true;

  // ── 工具 ──────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 配置 ──────────────────────────────────────────────────────────────────
  // 默认值、按钮白名单、校验规则全在 compose/config.js —— 选项页也要用同一套，
  // 抄两遍迟早起分歧。界面文案在 _locales/<code>/messages.json，取用见
  // compose/i18n.js。两个文件都由 background 的 composeScripts 排在本文件前面注入。
  //
  // 为什么默认块格式的名字也要走翻译：它是**配置默认值的一部分**
  // （'正文文本=div;段落=p;…'）。TinyMCE 自带的 block_formats 默认值是
  // 'Paragraph=p;Heading 1=h1;…'，中文语言包把 Paragraph 译成「段落」——
  // 而邮件里那个东西的正确叫法是「正文文本」。名字与标签都得能改，
  // 且名字要跟着界面语言走，所以 defaults() 是个需要 t 的函数。
  const CC = window.__tcsConfig;
  const I18N = window.__tcsI18n;
  if (!CC || !I18N) {
    console.error('[BetterCompose] compose/config.js 或 compose/i18n.js 未加载，不接管撰写窗口');
    return;
  }

  // blockFormats：块格式清单（'名=标签;名=标签'），顺序即下拉里的顺序，
  //   **第一项不是特殊项**，默认项单独由 defaultBlockFormat 指定 —— 这样
  //   「排在最前的」和「默认的」能分开。
  // defaultBlockFormat：新建段落 / 空文档使用的标签，必须在 blockFormats 里。
  //   「正文文本」为什么对应 div 而不是 p，见 compose/config.js 里那段注释。
  // toolbar：工具栏按钮与顺序，'|' 分组，未知按钮被丢弃。
  // 三者的默认值（含「正文文本」这类显示名）都在 compose/config.js 的 defaults()。

  // forced_root_block 只接受块级标签，白名单在 config.js 里。
  const BLOCK_TAGS = CC.BLOCK_TAGS;

  // 读存储里的覆盖项。storage 不可用（老版本 / 权限没给）或超时都退回默认 ——
  // 配置读不到不该拦住撰写窗口。
  // 这里只读出原始对象，不做规范化：规范化的默认值里含界面文案，
  // 得先知道用哪种语言才能算出来（见下面的顺序）。
  async function readRawConfig() {
    try {
      const store = browser.storage && browser.storage.local;
      if (store) {
        const got = await Promise.race([
          store.get(CC.CONFIG_KEY),
          sleep(800).then(() => null),
        ]);
        if (got && Object.prototype.hasOwnProperty.call(got, CC.CONFIG_KEY)) {
          log('用户配置已加载');
          return got[CC.CONFIG_KEY];
        }
      }
    } catch (e) {
      console.warn('[BetterCompose] 读配置失败，用默认值:', e);
    }
    return null;
  }

  // 顺序不能换：先拿到「用户选的语言」（配置里只有一个键，不需要翻译）
  // → 再按这门语言加载文案 → 最后规范化整份配置（默认块格式名要用 t）。
  const rawCfg = await readRawConfig();
  const i18n = await I18N.load(browser.runtime.getURL(''), rawCfg && rawCfg.language);
  const t = i18n.t;
  __tcsSay = t;

  // TinyMCE 的语言代码与 _locales 目录名并不总是一致：法语是 fr_FR、繁体是 zh_TW。
  // 英文是 TinyMCE 内置的，空串表示「不加载语言文件」。
  // 少了哪个文件的表现是「界面还是英文」，不会报错 —— check-i18n 会盯住这张表。
  const TM_LANG = {
    en: '', zh_CN: 'zh_CN', zh_TW: 'zh_TW', ja: 'ja',
    de: 'de', fr: 'fr_FR', es: 'es', ru: 'ru',
  };
  const tmLang = TM_LANG[i18n.locale] || '';

  // 下面是**运行期这份配置**：所有用到配置值的地方都读 cfg，别再写字面量。
  const cfg = CC.normalize(rawCfg, t);
  DEBUG = cfg.debug;

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  async function waitForBody(timeout = 2000) {
    const t0 = Date.now();
    while (!document.body) {
      if (Date.now() - t0 > timeout) return false;
      await sleep(50);
    }
    return true;
  }

  // 回复 / 转发时，ComposeWindow 是在正文文档加载**之后**才把引用原文写进
  // contentDocument.body（`body.innerHTML = …`）。compose script 注入比那次写入早，
  // 如果这时就抓 body 搭壳，写入会把 #tcs-toolbar / #tcs-content 一起冲掉：
  // 编辑器绑在一个已经脱离文档的容器上，用户看到的就是「回复时一直加载中」，
  // 或者「工具栏出来了、正文没了」。
  //
  // 所以搭壳前先等 body 静默：用 MutationObserver 而不是轮询 —— 引用正文可能
  // 有上百 KB，每 50ms 序列化一次 innerHTML 太浪费；observe 只在真变化时被叫醒。
  // 静默 = 连续 quiet 毫秒没有 childList/characterData 变化，最长等 timeout。
  function waitForBodyQuiet(quiet = 250, timeout = 3500) {
    return new Promise(resolve => {
      let settle = null;
      const finish = () => {
        clearTimeout(settle);
        clearTimeout(hard);
        obs.disconnect();
        resolve();
      };
      const bump = () => {
        clearTimeout(settle);
        settle = setTimeout(finish, quiet);
      };
      const obs = new MutationObserver(bump);
      const hard = setTimeout(finish, timeout);
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      bump();
    });
  }

  function banner(text, color) {
    let el = document.getElementById('_tcs_notice');
    if (!el) {
      el = document.createElement('div');
      el.id = '_tcs_notice';
      el.setAttribute('data-tcs-ui', '1');
      el.contentEditable = 'false';
      el.title = t('banner_click_close');
      el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;cursor:pointer;' +
        'padding:3px 8px;font:12px system-ui,sans-serif;color:#fff;';
      // 认了就不再自己消失：失败原因得让用户看得见。
      // 防外泄由 cleanContent / prepareForSend 负责（发送前会剥掉 [data-tcs-ui]）。
      el.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        el.remove();
      });
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.background = color || '#1565c0';
    el.textContent = text;
  }

  // ── 与 background 的通道 ──────────────────────────────────────────────────
  const port = browser.runtime.connect({ name: 'compose-studio' });
  const inbox = new Map();

  port.onMessage.addListener(msg => {
    const cb = inbox.get(msg.action);
    if (cb) {
      inbox.delete(msg.action);
      cb(msg);
    }
    if (msg.action === 'requestContent') {
      port.postMessage({ action: 'content', html: cleanContent() });
    } else if (msg.action === 'prepareForSend') {
      prepareForSend();
    }
  });

  function ask(action, payload, timeout = 1500) {
    return new Promise(resolve => {
      inbox.set(action === 'getComposeDetails' ? 'composeDetails' : action, resolve);
      try {
        port.postMessage(Object.assign({ action }, payload || {}));
      } catch (e) {
        inbox.delete(action);
        resolve(null);
      }
      setTimeout(() => {
        if (inbox.delete(action === 'getComposeDetails' ? 'composeDetails' : action)) {
          resolve(null);
        }
      }, timeout);
    });
  }

  // ── 清掉草稿里可能残留的旧 UI ─────────────────────────────────────────────
  function cleanStale() {
    if (!document.body) return;
    document.body
      .querySelectorAll('#_tcs_notice,#tcs-toolbar,[data-tcs-ui],[class*="tox-"]')
      .forEach(el => el.remove());
    // 存下来的草稿里，正文外面套着我们那个 #tcs-content 容器（更早的版本每存一次
    // 就多套一层）。这里把它拆掉、把内容原样还给 body —— 新壳随后会重新包一层，
    // 不然嵌套会一层层攒下去，"只保存原文"就更远了。
    document.body.querySelectorAll('#tcs-content').forEach(wrap => {
      if (!wrap.parentNode) return;
      while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    });
  }

  // ── 配置确认 ──────────────────────────────────────────────────────────────
  // 配置与语言在上面就读完了：搭壳要用 defaultBlockFormat 决定空邮件的占位块，
  // init 时要用 toolbar / block_formats，而这两件事都不能等 —— storage.get
  // 通常几毫秒，主流程本来就是 async IIFE，那点 await 不影响任何时机。
  // 这里不能调 blockLabel()：它是 const，声明在下面（UI 层），会撞暂时性死区。
  log('配置：语言=' + i18n.locale +
      '，默认块=' + cfg.defaultBlockFormat +
      '，块格式 ' + cfg.blockFormats.length + ' 项' +
      '，工具栏 ' + cfg.toolbar.filter(tok => tok !== '|').length + ' 个按钮' +
      (cfg.debug ? '，诊断日志已开' : ''));

  // ── 纯文本模式不接管 ──────────────────────────────────────────────────────
  await waitForBody();
  const detailsMsg = await ask('getComposeDetails');
  if (detailsMsg && detailsMsg.details && detailsMsg.details.isPlainText) {
    // 纯文本窗口不能碰 DOM：任何插入的节点都会原样进到邮件正文里
    log('纯文本撰写模式，不接管');
    return;
  }

  // 见 waitForBodyQuiet 的注释：回复 / 转发时正文是后写的，等它写完再搭壳，
  // 免得我们插的节点被那次 body.innerHTML 冲掉。
  await waitForBodyQuiet();
  cleanStale();

  // ── 搭壳：一行工具栏 + 正文容器 ───────────────────────────────────────────
  const toolbarEl = document.createElement('div');
  toolbarEl.id = 'tcs-toolbar';
  toolbarEl.setAttribute('data-tcs-ui', '1');
  toolbarEl.contentEditable = 'false';

  const contentEl = document.createElement('div');
  contentEl.id = 'tcs-content';

  const isUiNode = n => {
    if (n.nodeType !== 1) return false;
    if (n.id === '_tcs_notice' || n.id === 'tcs-toolbar' || n.id === 'tcs-content') return true;
    if (n.hasAttribute && n.hasAttribute('data-tcs-ui')) return true;
    if (n.classList && (
      n.classList.contains('tox') ||
      n.classList.contains('tox-tinymce') ||
      n.classList.contains('tox-tinymce-inline') ||
      n.classList.contains('tox-tinymce-aux') ||
      n.classList.contains('tox-silver-sink')
    )) return true;
    return false;
  };

  const kids = Array.from(document.body.childNodes).filter(n => !isUiNode(n));
  Array.from(document.body.childNodes).filter(isUiNode).forEach(n => n.remove());
  kids.forEach(n => contentEl.appendChild(n));

  // 空邮件需要给 TinyMCE 一个可定位的段落，否则光标落不下去。
  // 用配置里的默认块，别硬写 p —— 硬写 p 会让每封新邮件的首段直接变成「段落」，
  // TB 的格式下拉跟着显示「段落」，段间距也立刻是 p 的 margin。
  // （这里以前硬写 '<p><br></p>'，是同一个 bug 的另一半。）
  const hasContent = Array.from(contentEl.childNodes).some(n =>
    n.nodeType === 1 ? true : n.nodeType === 3 ? n.nodeValue.trim() !== '' : false
  );
  if (!hasContent) {
    const b = cfg.defaultBlockFormat;
    contentEl.innerHTML = '<' + b + '><br></' + b + '>';
  }

  document.body.appendChild(toolbarEl);
  document.body.appendChild(contentEl);
  contentEl.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 14px;';

  // body 的布局会丢：TB 重写 body.innerHTML 时不一定会重设 style，而 flex 布局是
  // 「工具栏钉在上、正文占满剩余高度」的前提。抽成函数是为了守卫能重放。
  function applyBodyLayout() {
    Object.assign(document.body.style, {
      margin: '0', padding: '0', height: '100%',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden', boxSizing: 'border-box',
    });
    document.body.contentEditable = 'false';
  }
  applyBodyLayout();

  // 发送中不要复位：prepareForSend 是故意把工具栏/弹出层摘掉的。
  let sending = false;

  // 守卫：TB 只要重写 body（回复/转发的引用原文迟到、切换引用方式、插入签名、
  // 新写信件第一次落内容），我们插的两个节点就会被一起冲掉 —— 编辑器于是绑在
  // 一个脱离文档的容器上，表现成「工具栏在、正文没了」或「一直加载中」。
  //
  // 这里把两个节点挂回去，并把 TB 新写进来的内容收进 #tcs-content。
  // 不用重新 init：TinyMCE 持有的是 contentEl 这个元素引用，只要元素还活着
  // 并回到文档里就能继续工作；重新 init 会丢掉撤销栈和光标位置。
  //
  // 只观察 body 的直接子节点、不 subtree：TinyMCE 在 #tcs-content 内部的每次
  // 输入都属于 subtree 变化，不该触发这里。
  function keepShellAttached() {
    const reattach = () => {
      if (sending) return;
      const stray = Array.from(document.body.childNodes)
        .filter(n => n !== toolbarEl && n !== contentEl && !isUiNode(n));
      const lost = !document.body.contains(toolbarEl) || !document.body.contains(contentEl);
      if (!lost && !stray.length) return;
      stray.forEach(n => contentEl.appendChild(n));
      if (!document.body.contains(toolbarEl)) {
        document.body.insertBefore(toolbarEl, document.body.firstChild);
      }
      if (!document.body.contains(contentEl)) document.body.appendChild(contentEl);
      applyBodyLayout();
      // 编辑器可能已经就绪（只是容器被搬家）：叫它刷一次选区与高度，
      // 否则工具栏的启用态和正文可视高度会停在被冲掉之前的样子。
      const ed = tmce && tmce.activeEditor;
      if (ed && ed.initialized) {
        try { ed.nodeChanged(); ed.fire('ResizeContent'); } catch (e) {}
      }
      log('body 被外部重写，已挂回工具栏与正文容器（收进 ' + stray.length + ' 个节点）');
    };
    // 一次重写会连着来好几条 mutation，合并成一次
    new MutationObserver(debounce(reattach, 0)).observe(document.body, { childList: true });
  }
  keepShellAttached();

  // 选区落在正文之外时，禁止退格把整块结构删掉
  document.addEventListener('keydown', e => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (!contentEl.contains(sel.getRangeAt(0).startContainer)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ── 先修文档模式，再加载 TinyMCE ────────────────────────────────────────
  // 撰写窗口的正文文档来自 about:blank，没有 doctype，因而是 quirks mode。
  // TinyMCE 7 的 inline 模式在这种文档里初始化会静默卡死：init 事件永不触发，
  // 界面就一直停在“加载中”。实测（Chrome，同一份资源与配置，只去掉 doctype）
  // 可以从 INIT-OK 复现成卡在 init 之前；把这个 getter 伪造成 CSS1Compat 后恢复。
  //
  // 文档已经解析完，改不了 doctype，只能在被读之前伪造 compatMode。
  if (document.compatMode !== 'CSS1Compat') {
    try {
      Object.defineProperty(document, 'compatMode', {
        configurable: true,
        get: () => 'CSS1Compat',
      });
      log('已伪造 document.compatMode = CSS1Compat');
    } catch (e) {
      console.warn('[BetterCompose] compatMode 补丁失败，TinyMCE 可能初始化不了:', e);
    }
  }

  // ── 加载 TinyMCE ─────────────────────────────────────────────────────────
  try {
    banner(t('banner_loading'));
    const resp = await fetch(BASE + '/tinymce.min.js');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    (0, eval)(await resp.text());

    tmce = typeof tinymce !== 'undefined' ? tinymce : window.tinymce;
    if (!tmce) throw new Error('tinymce is not defined');

    const orig = tmce.ScriptLoader && tmce.ScriptLoader.loadScript;
    if (orig) {
      tmce.ScriptLoader.loadScript = url =>
        fetch(url)
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.text();
          })
          .then(code => { (0, eval)(code); });
    }
  } catch (e) {
    console.error('[BetterCompose] TinyMCE 加载失败:', e);
    banner(t('banner_load_failed', [e.message]), '#c62828');
    return;
  }

  // ── 图片：按 Thunderbird 自己的规则打标记 ────────────────────────────────
  // TB 源码 EdImageLinkLoader.js 的判定：data:/file: 默认「附加到邮件」，
  // http(s) 看 mail.compose.attach_http_images。moz-do-not-send="false"
  // 就是「把这张图作为 MIME 部件随邮件发出」，由 TB 自己生成 cid 引用。
  const DNS_ATTR = 'moz-do-not-send';

  function markImage(img) {
    if (!img || img.nodeType !== 1) return;
    const src = (img.getAttribute('src') || '').trim();
    if (!src || /^cid:/i.test(src)) return;
    if (/^https?:/i.test(src)) {
      img.setAttribute(DNS_ATTR, 'true');
    } else {
      img.setAttribute(DNS_ATTR, 'false');
    }
  }

  function markAllImages(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('img').forEach(markImage);
  }

  // ── 格式刷 ───────────────────────────────────────────────────────────────
  // 语义照 Word：点一下取样 → 选中目标就套用 → 保持激活可以连续刷 → 再点按钮或 Esc 退出。
  // 之前的实现刷完一次就自动结束，用户往往以为“只生效了一半”或者“根本没反应”。
  function registerPlugins() {
    tmce.PluginManager.add('tcs_fp', ed => {
      let fmt = null;
      let painting = false;
      let btnApi = null;

      const flash = text => {
        try {
          ed.notificationManager.open({ text, timeout: 2600 });
        } catch (e) {
          log(text);
        }
      };

      const setPainting = on => {
        painting = on;
        if (!on) fmt = null;
        try {
          ed.getContainer().style.cursor = on ? 'crosshair' : '';
        } catch (e) {}
        if (btnApi) btnApi.setActive(on);
      };

      // 取样：字符级格式。颜色/底色/字号/字体只取**显式声明过**的，
      // 不把继承来的计算值固化进去 —— 否则刷「默认黑字」会写出
      // color:#000、font-size:14px、font-family:system-ui 一堆冗余 span，
      // 收件端字体一换就走了样，而且看起来像“刷了什么也没变”。
      const capture = () => {
        const n = ed.selection.getNode();
        let styled = n;
        const body = ed.getBody();
        while (styled && styled.nodeType === 1 && !styled.getAttribute('style') && styled !== body) {
          styled = styled.parentNode;
        }
        const sx = styled && styled.nodeType === 1 && styled.getAttribute('style') ? styled.style : null;
        const explicit = p => (sx && sx[p]) || '';
        return {
          bold: ed.formatter.match('bold'),
          italic: ed.formatter.match('italic'),
          underline: ed.formatter.match('underline'),
          strike: ed.formatter.match('strikethrough'),
          fg: explicit('color'),
          bg: explicit('backgroundColor'),
          fs: explicit('fontSize'),
          ff: explicit('fontFamily'),
        };
      };

      const apply = f => {
        const toggle = (name, on) => (on ? ed.formatter.apply(name) : ed.formatter.remove(name));
        toggle('bold', f.bold);
        toggle('italic', f.italic);
        toggle('underline', f.underline);
        toggle('strikethrough', f.strike);
        const visible = v => v && v !== 'transparent' && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(v);
        if (visible(f.fg)) ed.formatter.apply('forecolor', { value: f.fg });
        if (visible(f.bg)) ed.formatter.apply('hilitecolor', { value: f.bg });
        if (f.fs) ed.formatter.apply('fontsize', { value: f.fs });
        if (f.ff) ed.formatter.apply('fontname', { value: f.ff });
      };

      ed.ui.registry.addToggleButton('tcs_fp', {
        icon: 'format-painter',
        tooltip: t('fp_tooltip'),
        onSetup: api => {
          btnApi = api;
          return () => {
            btnApi = null;
          };
        },
        onAction: () => {
          if (painting) {
            setPainting(false);
            return;
          }
          if (ed.selection.isCollapsed()) {
            flash(t('fp_need_selection'));
            return;
          }
          fmt = capture();
          setPainting(true);
          flash(t('fp_sampled'));
        },
      });

      // 选中即套用，但保持激活；只是点一下取消选区不算一次刷
      ed.on('mouseup', () => {
        if (!painting || !fmt || ed.selection.isCollapsed()) return;
        setTimeout(() => {
          if (painting && fmt && !ed.selection.isCollapsed()) apply(fmt);
        }, 0);
      });

      ed.on('keydown', e => {
        if (e.key === 'Escape' && painting) setPainting(false);
      });
    });
  }

  // ── 折叠菜单 ─────────────────────────────────────────────────────────────
  // 只留一个「菜单」按钮。原来五个文字菜单（编辑/格式/插入/表格/视图）横排，
  // 光它们就吃掉 300 多 px，窗口一窄右侧按钮就全被 sliding 收进「更多」；
  // 而且点开一个菜单，里面还有十几个条目要纵向找。
  //
  // 现在的结构：顶层只有「撤销/重做 → 四个分组 → 查找替换」，分组用
  // nestedmenuitem 折进二级。功能一项没少，横向占用从 5 个按钮降到 1 个。
  // 调色板只有一个来源：菜单里的「文字颜色」、菜单顶上的「标红」、工具栏两个色板
  // 按钮共用这份表。分成三份的后果不是多写几行，而是同一个「红色」在不同入口里
  // 是**两个不同的红**（原来菜单里是 #c0392b，工具栏那份写的是 #ff0000）。
  // 取色偏暗一档：邮件正文是白底黑字，纯 #ff0000 / #ffff00 在正文里刺眼且发虚。
  // 十六进制不带 '#'：TinyMCE 的 color_map 要的是纯值，'#' 由它自己补。
  // 色板：TinyMCE 官方默认那 22 色（5 列 × 4 行 + 末行黑/白），色名换成中文。
  // 顺序不要重排 —— 它自己就是按「浅色 / 标准 / 深色 / 灰阶 / 黑白」分行的，
  // 菜单里的分隔线也是照这个节奏切的（每 5 个一条）。
  // 之前只放 11 格，是怕在 28px 高的工具栏里点不准；实际用下来"可选的颜色太少"
  // 比"格子密"更难受，于是按官方示例铺开 —— 5 列的密度在实测里是可点的。
  // 色名走翻译：色板项的 text 会过 TinyMCE 自己的 translate()，语言包里没有
  // 的名字原样输出 —— 所以我们自己先翻好。键名与 hex 分开存，翻译在 COLORS
  // 这一步做；菜单里的「标红」按键取色，不再靠中文色名反查。
  const PALETTE = [
    ['color_light_green', 'BFEDD2'], ['color_light_yellow', 'FBEEB8'],
    ['color_light_red', 'F8CAC6'], ['color_light_purple', 'ECCAFA'],
    ['color_light_blue', 'C2E0F4'],
    ['color_green', '2DC26B'], ['color_yellow', 'F1C40F'], ['color_red', 'E03E2D'],
    ['color_purple', 'B96AD9'], ['color_blue', '3598DB'],
    ['color_dark_cyan', '169179'], ['color_orange', 'E67E23'],
    ['color_dark_red', 'BA372A'], ['color_dark_purple', '843FA1'],
    ['color_dark_blue', '236FA1'],
    ['color_light_gray', 'ECF0F1'], ['color_mid_gray', 'CED4D9'],
    ['color_gray', '95A5A6'], ['color_dark_gray', '7E8C8D'], ['color_navy', '34495E'],
    ['color_black', '000000'], ['color_white', 'FFFFFF'],
  ];
  const COLORS = PALETTE.map(([key, hex]) => [t(key), '#' + hex]);
  const RED = '#' + PALETTE.find(([key]) => key === 'color_red')[1];
  const HILITE = [
    [t('hl_yellow'), '#fff3cd'],
    [t('hl_gray'), '#f1f1f1'],
    [t('hl_none'), null],
  ];
  const SIZES = ['12pt', '14pt', '16pt', '18pt', '24pt'];


  // 字体栈写全：只用 "SimSun" 这种单一名字，收件端（macOS/mobile）经常没有该字，
  // 会掉回自己的默认字体；带上平台常见的等效字更稳。null = 取消字体设置。
  // 第三项是**按钮上显示的短标签**：工具栏要显示当前值，而 "Times New Roman"
  // 这种全名会把整条单行工具栏撑开；可读性优先，取「用户认得出的那个词」。
  const FONTS = [
    [t('font_system'), null, t('font_system')],
    [t('font_sim_sun'), 'SimSun, "Songti SC", "Noto Serif CJK SC", serif',
     t('font_sim_sun_short')],
    [t('font_ya_hei'), '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
     t('font_ya_hei_short')],
    [t('font_sim_hei'), 'SimHei, "Heiti SC", "Noto Sans CJK SC", sans-serif',
     t('font_sim_hei_short')],
    [t('font_kai_ti'), 'KaiTi, "Kaiti SC", "Noto Serif CJK SC", serif',
     t('font_kai_ti_short')],
    ['Arial', 'Arial, Helvetica, sans-serif', 'Arial'],
    ['Times New Roman', '"Times New Roman", Times, serif', 'Times'],
    ['Courier New', '"Courier New", Courier, monospace', 'Courier'],
    ['Verdana', 'Verdana, Geneva, sans-serif', 'Verdana'],
    ['Georgia', 'Georgia, serif', 'Georgia'],
  ];

  const FONT_SIZES = [
    [t('size_default'), null],
    ['10pt', '10pt'], ['11pt', '11pt'], ['12pt', '12pt'], ['14pt', '14pt'],
    ['16pt', '16pt'], ['18pt', '18pt'], ['20pt', '20pt'], ['24pt', '24pt'],
    ['28pt', '28pt'], ['36pt', '36pt'],
  ];

  // 字体族名只比第一段：声明里带一串 fallback（SimSun, "Songti SC", …），
  // 而计算样式原样返回整串；取头一个再比对，才不会因为 fallback 差异漏配。
  const firstFamily = v =>
    String(v || '').split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();

  // 没设字体时计算值是 content_style 里的 system-ui 栈（或空）→ 归到「系统默认」
  const DEFAULT_FAMILIES = /^(|system-ui|-apple-system|inherit|initial|unset)$/;

  const currentFontLabel = family => {
    const first = firstFamily(family);
    if (DEFAULT_FAMILIES.test(first)) return t('font_system');
    const hit = FONTS.find(([, value]) => value && firstFamily(value) === first);
    return hit ? hit[2] : first;           // 清单外的字体，如实显示族名
  };

  // 浏览器给的是 px，邮件里写的是 pt：14px 正文 = 10.5pt。保持一位小数，
  // 10pt→13.33px 这类换算能回到 10pt 而不是 10.000000000000002。
  const currentSizeLabel = px => {
    if (!px) return '';
    const pt = Math.round(px * 0.75 * 10) / 10;
    return (Number.isInteger(pt) ? pt : pt.toFixed(1)) + 'pt';
  };

  // 「当前值」读的是选区起点元素的**计算样式**，不是 formatter 记录：
  // 粘贴进来、别人发过来的 <span style="font-family:宋体"> 没有经过我们的
  // formatter，但计算样式一定有 —— 显示当前值这条要求不该依赖来源。
  const styleAtCaret = ed => {
    const start = ed.selection.getStart();
    const el = start && start.nodeType === 1 ? start : (start && start.parentElement);
    const view = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    return view.getComputedStyle(el || ed.getBody());
  };

  // 工具栏可能在 light DOM（#tcs-toolbar 直属子节点），也可能已经搬进它的
  // shadow root（见 mountToolbarInShadow）。所有"找工具栏里的元素"的代码都得
  // 走这里，否则搬完之后 querySelector 一个也找不到。
  function uiRoot() {
    const host = document.getElementById('tcs-toolbar');
    return (host && host.shadowRoot) || host || document;
  }

  // menubutton 的 text 是注册时定死的常量，TinyMCE 7 的按钮实例 API 里没有
  // setText（只有 setEnabled / setActive），所以标签只能落到 DOM 上：
  // 按钮带 data-mce-name，文字在 .tox-tbtn__select-label 里。
  function setButtonLabel(name, text) {
    if (!text) return;
    const bar = uiRoot();
    const label = bar &&
      bar.querySelector('[data-mce-name="' + name + '"] .tox-tbtn__select-label');
    if (label && label.textContent !== text) label.textContent = text;
  }

  // 块格式的显示名由 blockFormats 决定，代码里不再出现「段落」这类字面量。
  const blockLabel = tag => {
    const hit = cfg.blockFormats.find(([, v]) => v === tag);
    return hit ? hit[0] : tag;
  };

  // 当前块标签：从选区起点往上找**最近的块级元素**。
  // 不用 formatter.match —— TinyMCE 的 formatter 表里没有 'p'（段落是"没有任何
  // format"的状态），match('p') 恒为 false，下拉永远勾不中「正文文本」。
  function currentBlock(ed) {
    let node = ed.selection.getStart();
    const body = ed.getBody();
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== body) {
      const name = node.nodeName && node.nodeName.toLowerCase();
      if (name && BLOCK_TAGS.includes(name)) return name;
      node = node.parentElement;
    }
    // 光标在正文最外层：这时文档的"默认块"就是 forced_root_block，
    // 而它就是配置里的 defaultBlockFormat（默认 div = 「正文文本」）。
    return String(ed.getParam('forced_root_block') || cfg.defaultBlockFormat).toLowerCase();
  }

  function applyBlock(ed, tag) {
    try {
      // 传**裸标签名**：'<h1>' 这种带尖括号的老写法在 TinyMCE 7.9.3 里是静默
      // 无效的 —— 实测 p→p、div→div，什么都不发生，也不报错。FormatBlock 只认
      // 'h1' / 'div' 这种形式。（带尖括号的写法是静默无效的：不报错，也不发生
      // 任何事。而且它假性正常 —— 默认块就是 p，点「正文文本」等于点了个同名项。）
      ed.execCommand('FormatBlock', false, tag);
    } catch (e) {
      console.warn('[BetterCompose] FormatBlock 失败:', tag, e);
    }
  }

  function refreshValueLabels(ed) {
    try {
      const cs = styleAtCaret(ed);
      setButtonLabel('tcs_font', currentFontLabel(cs.fontFamily));
      setButtonLabel('tcs_size', currentSizeLabel(parseFloat(cs.fontSize)));
      setButtonLabel('tcs_block', blockLabel(currentBlock(ed)));
    } catch (e) {
      // 选区正在切换时可能取不到元素；下一次 NodeChange 会补上，不必刷屏报错
    }
  }

  function registerMenus(ed) {
    const run = cmd => () => { try { ed.execCommand(cmd); } catch (e) { console.warn(cmd, e); } };
    const item = (text, onAction, icon) =>
      Object.assign({ type: 'menuitem', text, onAction }, icon ? { icon } : {});
    // TinyMCE 7 的嵌套菜单字段是 getSubmenuItems（6.x 是 getSubmenu，
    // 写错版本会在菜单打开的瞬间抛 getSubmenuItems is not a function）。
    const group = (text, getSubmenuItems) => ({ type: 'nestedmenuitem', text, getSubmenuItems });
    const sep = { type: 'separator' };
    // 带勾选的菜单项：段落格式要能看出当前光标在哪一档。
    const toggle = (text, onAction, active) =>
      ({ type: 'togglemenuitem', text, onAction, active: !!active });

    const clipboard = () => [
      item(t('clip_cut'), run('Cut')),
      item(t('clip_copy'), run('Copy')),
      item(t('clip_paste'), run('Paste')),
      item(t('clip_select_all'), run('SelectAll'), 'select-all'),
    ];

    const format = () => [
      // 段落格式排在最前面 —— 它是"这一段是什么"的第一性问题，比颜色更基础。
      // 显示名来自 blockFormats，默认第一项是「正文文本」而不是 TinyMCE 自带的
      // 「段落」（那是 block_formats 默认值 'Paragraph=p' 的译文）。
      // getSubmenuItems 是打开菜单那一刻才调用的，所以 active 取的是实时值。
      group(t('fmt_block'), () => cfg.blockFormats.map(([text, tag]) =>
        toggle(text, () => { applyBlock(ed, tag); refreshValueLabels(ed); },
               currentBlock(ed) === tag))),
      sep,
      // 「标红」不在工具栏上（那里只留 18 个高频按钮），放在这里 ——
      // 功能没丢，只是不占工具栏宽度。
      item(t('fmt_mark_red'), () => ed.formatter.apply('forecolor', { value: RED })),
      // 22 个色名排成一列太长，按色板的行切分隔线（浅色 / 标准 / 深色 / 灰阶 / 黑白），
      // 和弹出的色板是同一个视觉分组，不用重新认一遍。
      group(t('fmt_text_color'), () => COLORS.flatMap(([text, value], i) => {
        const it = item(text, () => ed.formatter.apply('forecolor', { value }));
        return i > 0 && i % 5 === 0 ? [sep, it] : [it];
      })),
      group(t('fmt_highlight'), () => HILITE.map(([text, value]) =>
        item(text, () => (value ? ed.formatter.apply('hilitecolor', { value })
                               : ed.formatter.remove('hilitecolor'))))),
      group(t('fmt_size'), () => SIZES.map(v =>
        item(v, () => ed.formatter.apply('fontsize', { value: v })))),
      sep,
      item(t('fmt_bold'), run('Bold'), 'bold'),
      item(t('fmt_italic'), run('Italic'), 'italic'),
      item(t('fmt_underline'), run('Underline'), 'underline'),
      item(t('fmt_strike'), run('Strikethrough'), 'strike-through'),
      sep,
      item(t('align_left'), run('JustifyLeft'), 'align-left'),
      item(t('align_center'), run('JustifyCenter'), 'align-center'),
      item(t('align_right'), run('JustifyRight'), 'align-right'),
      sep,
      item(t('fmt_list_bullet'), run('InsertUnorderedList'), 'unordered-list'),
      item(t('fmt_list_number'), run('InsertOrderedList'), 'ordered-list'),
      sep,
      item(t('fmt_clear'), run('RemoveFormat'), 'remove-formatting'),
    ];

    const insert = () => [
      item(t('ins_image'), run('mceImage'), 'image'),
      item(t('ins_link'), run('mceLink'), 'link'),
      item(t('ins_table'), run('mceInsertTable'), 'table'),
      sep,
      item(t('ins_hr'), () => ed.insertContent('<hr>'), 'horizontal-rule'),
      item(t('ins_charmap'), run('mceShowCharmap'), 'insert-character'),
      item(t('ins_date'), run('mceInsertDate')),
      item(t('ins_time'), run('mceInsertTime')),
      item(t('ins_anchor'), run('mceAnchor'), 'bookmark'),
    ];

    const table = () => [
      item(t('tbl_insert'), run('mceInsertTable'), 'table'),
      sep,
      item(t('tbl_row_above'), run('mceTableInsertRowBefore')),
      item(t('tbl_row_below'), run('mceTableInsertRowAfter')),
      item(t('tbl_row_delete'), run('mceTableDeleteRow')),
      sep,
      item(t('tbl_col_before'), run('mceTableInsertColBefore')),
      item(t('tbl_col_after'), run('mceTableInsertColAfter')),
      item(t('tbl_col_delete'), run('mceTableDeleteCol')),
      sep,
      item(t('tbl_merge'), run('mceTableMergeCells')),
      item(t('tbl_split'), run('mceTableSplitCells')),
      item(t('tbl_delete'), run('mceTableDelete'), 'table-delete-table'),
    ];

    const view = () => [
      item(t('view_source'), run('mceCodeEditor'), 'sourcecode'),
      item(t('view_fullscreen'), run('mceFullScreen'), 'fullscreen'),
      item(t('view_blocks'), run('mceVisualBlocks'), 'visualblocks'),
    ];

    ed.ui.registry.addMenuButton('tcs_menu', {
      text: t('tb_menu'),
      tooltip: t('tb_menu_tip'),
      fetch: cb => cb([
        item(t('menu_undo'), run('Undo'), 'undo'),
        item(t('menu_redo'), run('Redo'), 'redo'),
        sep,
        group(t('menu_clipboard'), clipboard),
        group(t('menu_format'), format),
        group(t('menu_insert'), insert),
        group(t('menu_table'), table),
        group(t('menu_view'), view),
        sep,
        item(t('menu_find_replace'), run('SearchReplace')),
      ]),
    });
  }

  // ── 工具栏按钮 ───────────────────────────────────────────────────────────
  // 三个下拉式菜单按钮（字体 / 字体大小 / 对齐）。都用 menubutton 而不用
  // TinyMCE 7 内置的 fontfamily、fontsize —— 那两个在 7 里改成了“点开一个对话框再
  // 输入”，选个字体要开窗关窗，对邮件这种高频动作太重；menubutton 是一层下拉，
  // 一步到位，而且和「菜单」的交互保持一致。
  // 字体 / 字体大小两个按钮显示**当前值**（Word 的观感：按钮上是“宋体”“18pt”，
  // 不是一个恒定的“字体”“字体大小”占位）。
  // 格式刷用内置的 format-painter 图标（icons 包里有，128 个图标里之前没搜到，
  // 自己画了三版 —— 竖画笔像手电筒、多缕刷毛像叉子、斜握圆头笔像棒棒糖 —— 都不如它）。
  function registerToolbar(ed) {
    const run = cmd => () => { try { ed.execCommand(cmd); } catch (e) { console.warn(cmd, e); } };

    // 下拉里勾出当前项：先按 keyOf 归一化再比，找不到就把第一项（默认/系统默认）
    // 勾上 —— 正文 14px = 10.5pt，不在 10/11/12 的清单里，那它确实就是“默认”。
    const pick = (list, fmt, keyOf, currentKey) => cb => {
      const cur = currentKey();
      const keys = list.map(([, value]) => keyOf(value));
      const at = keys.indexOf(cur);
      cb(list.map(([text, value], i) => ({
        type: 'togglemenuitem',
        text,
        active: i === (at < 0 ? 0 : at),
        onAction: () => {
          if (value) ed.formatter.apply(fmt, { value });
          else ed.formatter.remove(fmt);
          refreshValueLabels(ed);
        },
      })));
    };

    const none = '\u0000none';
    const currentFontKey = () => {
      const first = firstFamily(styleAtCaret(ed).fontFamily);
      return DEFAULT_FAMILIES.test(first) ? none : first;
    };
    const currentSizeKey = () => currentSizeLabel(parseFloat(styleAtCaret(ed).fontSize)) || none;

    // 字体 / 字体大小：折叠选择器，作用于选区；光标没选中时对“接下来输入的字”生效。
    // 初始 text 取「默认状态下的真实值」而不是占位词：TinyMCE 在渲染时按 text
    // 量出按钮的内联宽度并定死，写占位词会让后面的值被 ellipsis 截掉。
    ed.ui.registry.addMenuButton('tcs_font', {
      text: t('font_system'),
      tooltip: t('tb_font_tip'),
      fetch: pick(
        FONTS, 'fontname',
        value => (value ? firstFamily(value) : none),
        currentFontKey
      ),
    });

    ed.ui.registry.addMenuButton('tcs_size', {
      text: '10.5pt',
      tooltip: t('tb_size_tip'),
      fetch: pick(
        FONT_SIZES, 'fontsize',
        value => value || none,
        currentSizeKey
      ),
    });

    // 段落格式（块格式）：和字体 / 字号一样显示**当前值**，默认那一档叫
    // 「正文文本」—— 名字来自 blockFormats，不再是 TinyMCE 自带的「段落」。
    // 初始 text 必须是真实默认值：menubutton 的内联宽度是按初始 text 量出来
    // 定死的，写占位词会让后面的值被 ellipsis 截掉（踩过）。
    ed.ui.registry.addMenuButton('tcs_block', {
      text: blockLabel(cfg.defaultBlockFormat),
      tooltip: t('tb_block_tip'),
      fetch: cb => {
        const cur = currentBlock(ed);
        cb(cfg.blockFormats.map(([text, tag]) => ({
          type: 'togglemenuitem',
          text,
          active: cur === tag,
          onAction: () => { applyBlock(ed, tag); refreshValueLabels(ed); },
        })));
      },
    });

    // 对齐：平铺三个按钮，不再收进「对齐 ▾」下拉。
    // 对齐是高频且互斥的动作，多一层下拉等于每次多一次点击；三个图标一共
    // 只比原来的文字按钮宽 38px，值得。
    // 用 toggleButton 而不是 button：三个状态互斥，当前段落是居中时「居中」
    // 要亮着 —— 否则用户看不出这段到底对哪边。判定走 formatter.match，
    // 和菜单里的 Justify* 命令是同一套 formatter。
    [
      ['tcs_align_l', 'JustifyLeft', 'alignleft', 'align-left', t('align_left')],
      ['tcs_align_c', 'JustifyCenter', 'aligncenter', 'align-center', t('align_center')],
      ['tcs_align_r', 'JustifyRight', 'alignright', 'align-right', t('align_right')],
    ].forEach(([name, cmd, fmt, icon, tooltip]) => {
      ed.ui.registry.addToggleButton(name, {
        icon,
        tooltip,
        onAction: run(cmd),
        onSetup: api => {
          const refresh = () => {
            try { api.setActive(!!ed.formatter.match(fmt)); } catch (e) {}
          };
          ed.on('NodeChange', refresh);
          refresh();
          return () => ed.off('NodeChange', refresh);
        },
      });
    });

    // 表情：面板用 emoticons 插件原装的（标题「表情符号」、九个分类、搜索框都由
    // 语言包翻成中文），只把按钮换成自己注册的 —— 插件那个按钮的 tooltip 是
    // 硬编码英文 "Emojis"，一条中文工具栏里挂个英文悬停提示太扎眼。
    // 数据 190 KB 由插件在 init 后异步加载，不点按钮不参与启动。
    ed.ui.registry.addButton('tcs_emoji', {
      icon: 'emoji',
      tooltip: t('tb_emoji_tip'),
      onAction: run('mceEmoticons'),
    });
  }

  // ── 选色器：给饱和度/亮度面板垫底色的 CSS 渐变，并跟随色相条 ─────────────
  // shell.css 里给 .tox-sv-palette-spectrum 写了三层等价渐变（底色 + 白→透明
  // + 透明→黑）。canvas 自己画得出来时背景被完全盖住，画不出来时它就是面板本身。
  // 唯一需要 JS 补的是「色相」：silver 主题把它存在 canvas 内部，只能从色相条的
  // aria-valuenow 反读（onChange 里写的是 Math.floor(360 - 3.6 * y)，与 hue 同值）。
  // 初始值不能读 —— 那个 120 是写死的假值，内部 paletteHue 实际是 0。
  function patchColorPicker(ed) {
    const bind = root => {
      const canvas = root.querySelector('.tox-sv-palette-spectrum');
      if (!canvas || canvas.dataset.tcsHueBound) return;
      canvas.dataset.tcsHueBound = '1';
      canvas.style.setProperty('--tcs-hue', '0');

      const slider = root.querySelector('.tox-hue-slider[aria-valuenow]');
      if (!slider) return;
      const sync = () => {
        const n = parseInt(slider.getAttribute('aria-valuenow'), 10);
        if (!Number.isFinite(n)) return;
        canvas.style.setProperty('--tcs-hue', String(((n % 360) + 360) % 360));
      };
      new MutationObserver(sync).observe(slider, {
        attributes: true, attributeFilter: ['aria-valuenow'],
      });
    };

    // 对话框挂进常驻的 .tox-tinymce-aux sink，不在文档流顶层；OpenWindow 又比
    // DOM 插入早一拍，所以两条路都走：事件触发后补扫几次，外加一个增量观察器
    // 只在新增元素上做一次 querySelector（打字时新增的是正文节点，代价可忽略）。
    //
    // ⚠️ 工具栏整棵在 #tcs-toolbar 的 shadow root 里，sink 作为它的子节点
    // 也被一起带了进去 —— 所以 document 里一个 .tox-dialog 都扫不到，必须连 shadow
    // 一起扫。shadow root 要等工具栏渲染完才存在，观察器因此延后挂。
    const roots = () => {
      const h = document.getElementById('tcs-toolbar');
      const sr = h && h.shadowRoot;
      return sr ? [document, sr] : [document];
    };
    const scan = root => (root.querySelectorAll ? root.querySelectorAll('.tox-dialog') : [])
      .forEach(bind);
    const scanSoon = () => { [0, 60, 200].forEach(ms => setTimeout(() => roots().forEach(scan), ms)); };

    const onMut = muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.classList && n.classList.contains('tox-dialog')) bind(n);
        else if (n.querySelector) scan(n);
      }));
    };
    const watch = root => new MutationObserver(onMut)
      .observe(root, { childList: true, subtree: true });

    watch(document.body);
    const watchShadow = () => {
      const h = document.getElementById('tcs-toolbar');
      const sr = h && h.shadowRoot;
      if (sr && !sr.__tcsWatched) { sr.__tcsWatched = true; watch(sr); }
    };
    setTimeout(watchShadow, 0);
    setTimeout(watchShadow, 800);

    ed.on('OpenWindow', () => { watchShadow(); scanSoon(); });
  }

  // ── Markdown 粘贴转换 ─────────────────────────────────────────────────────
  // TinyMCE 官方的 markdown 插件要付费订阅，GPL 包里连文件都没有；它做的事
  // 就是「paste 时判断纯 md → 转 HTML」，用 PastePreProcess 事件自己接一遍即可。
  // 解析与检测在 compose/markdown.js（纯函数，node 可测），这里只负责：
  //   1. 判断这次粘贴该不该管（内部粘贴不管、源带 text/html 不管）
  //   2. 把 HTML 形态的纯文本还原成原文再喂给解析器
  //   3. 没有真 HTML 标签才换 content —— 从网页复制的富文本一律不动
  //
  // undo：TinyMCE 自己的 paste 流程会压一层 undo level，所以 Ctrl+Z 能退回
  // 「粘贴之前」。不追求「退回原始 md 文本」（那要先把纯文本插进文档再转换，
  // 中间态会闪一下，得不偿失）。
  function registerMarkdownPaste(ed) {
    if (!cfg.markdownPaste) {
      log('markdownPaste 已关闭，粘贴不转换');
      return;
    }
    const md = window.__tcsMarkdown;
    if (!md) {
      console.warn('[BetterCompose] compose/markdown.js 未加载，粘贴转换已跳过');
      return;
    }

    // 「还原纯文本」和「是否像 md」都在 markdown.js 里（纯函数，node 可测），
    // 这里只负责把结果塞回去。htmlToPlain 返回 null = 剪贴板本来就有格式。
    ed.on('PastePreProcess', ev => {
      try {
        if (ev.internal) return;                    // 编辑器内部拖拽/粘贴
        const text = md.htmlToPlain(ev.content);
        if (!text) return;
        if (!md.looksLikeMarkdown(text)) return;
        const html = md.toHtml(text);
        if (!html) return;
        ev.content = html;
        log('粘贴的 markdown 已转换', text.length, '字符');
      } catch (e) {
        // 转换失败就让它按原样粘 —— 绝不能因为一个解析 bug 让用户粘不进来
        console.warn('[BetterCompose] markdown 转换失败，按原文粘贴:', e);
      }
    });
  }

  // ── 序列化：交给发送管线之前把 UI 摘干净、把图片标记补齐 ─────────────────
  function cleanContent() {
    const ed = tmce && tmce.activeEditor;
    const raw = ed ? ed.getContent() : contentEl.innerHTML;
    const doc = new DOMParser().parseFromString('<div id="__tcs">' + raw + '</div>', 'text/html');
    const root = doc.getElementById('__tcs');
    if (!root) return raw;
    root.querySelectorAll(
      '#_tcs_notice,#tcs-toolbar,[data-tcs-ui],.tox,.tox-tinymce,' +
      '.tox-tinymce-inline,.tox-tinymce-aux,.tox-silver-sink'
    ).forEach(n => n.remove());
    markAllImages(root);
    return root.innerHTML;
  }

  function prepareForSend() {
    sending = true;
    window.__tcsSending = true;
    try {
      document.querySelectorAll(
        '#_tcs_notice,#tcs-toolbar,[data-tcs-ui],.tox,.tox-tinymce,' +
        '.tox-tinymce-inline,.tox-tinymce-aux,.tox-silver-sink'
      ).forEach(n => n.remove());
    } catch (e) {}
    port.postMessage({ action: 'prepareForSendAck' });
  }

  // ── 把工具栏搬进 shadow root：存草稿时不再带走 TinyMCE 的 DOM ─────────────
  // Thunderbird 存草稿（含自动保存与关闭时的"保存"）时，正文是直接把**整个编辑器
  // 文档序列化**得到的：nsMsgCompose::SendMsg 里 m_editor->OutputToString("text/html",
  // OutputFormatted|…)，flag 里没有 SkipInvisibleContent 之类的开关，序列化器
  // 从 document 开始逐层遍历到每个子节点。而 compose API 只有 onAfterSave、
  // 没有"保存之前"的事件，所以没有任何跳板可以在那之前把 UI 摘掉。
  //
  // 结论：只要 UI 待在 light DOM 里，它就一定会进草稿。而 shadow tree 不在
  // light DOM 的遍历路径上 —— 序列化走不到它，渲染和事件却完全正常。
  // 于是把工具栏整棵子树搬进 #tcs-toolbar 的 shadow root：
  //   看得见、点得动、菜单照常弹，但草稿里只剩一个空的容器。
  // 样式得跟着搬 —— shadow 里拿不到文档样式表，skin 与 shell 两份都得内联进去。
  let uiCssCache = null;

  async function uiCss() {
    if (uiCssCache) return uiCssCache;
    const get = url => fetch(url).then(r => (r.ok ? r.text() : '')).catch(() => '');
    const [skin, shell] = await Promise.all([
      get(BASE + '/skins/ui/oxide/skin.min.css'),
      get(browser.runtime.getURL('compose/shell.css')),
    ]);
    // shell.css 里 #tcs-toolbar 指的是"工具栏容器"；进了 shadow，它就是这个
    // shadow 的宿主，选择器得换成 :host，否则单行、不换行、分组竖线全失效。
    uiCssCache = skin + '\n' + shell.replace(/#tcs-toolbar\b/g, ':host');
    return uiCssCache;
  }

  async function mountToolbarInShadow(ed) {
    const host = document.getElementById('tcs-toolbar');
    if (!host || host.shadowRoot || !host.firstChild) return false;

    // 先把 CSS 取回来：这一步失败还能安全放弃（DOM 一点没动）
    let css;
    try {
      css = await uiCss();
    } catch (e) {
      console.warn('[BetterCompose] 工具栏样式取不到，保持原样:', e);
      return false;
    }
    if (!host.firstChild || host.shadowRoot) return false;

    let root;
    try {
      root = host.attachShadow({ mode: 'open' });
      applyShadowCss(root, css);
      // 先放一个 slot：万一后面要回滚，把节点放回 light DOM 仍然能看见
      root.appendChild(document.createElement('slot'));

      const frag = document.createDocumentFragment();
      while (host.firstChild) frag.appendChild(host.firstChild);
      root.appendChild(frag);
    } catch (e) {
      console.warn('[BetterCompose] 工具栏搬进 shadow 失败，保持原样:', e);
      rollbackShadow(host);
      return false;
    }

    // 自检：按钮没跟着渲染出来就说明这套环境不吃 shadow，退回去
    if (!root.querySelectorAll('.tox-tbtn').length) {
      console.warn('[BetterCompose] shadow 里没有渲染出工具栏按钮，回滚');
      rollbackShadow(host);
      return false;
    }

    // sliding 是按宽度决定哪些按钮收进「更多」的，换父节点后让它重算一次
    try { ed.fire('ResizeContent'); ed.dispatch('resize'); } catch (e) {}
    log('工具栏已搬进 shadow root（草稿里不会再有 TinyMCE 的 DOM），按钮 ' +
        root.querySelectorAll('.tox-tbtn').length + ' 个');
    return true;
  }

  // 样式表用 constructable stylesheet，而不是塞一个 <style> 进去：撰写窗口的 CSP
  // 会管 style-src，行内样式未必放行；adoptedStyleSheets 是 CSSOM 对象，不过 CSP
  // 这一关。环境不支持（很老的 Gecko）才退回 <style>。
  function applyShadowCss(root, css) {
    try {
      if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) {
      console.warn('[BetterCompose] adoptedStyleSheets 不可用，退回 <style>:', e);
    }
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
  }

  // 回滚：把它们放回 light DOM，靠 shadow 里那个 slot 继续渲染
  function rollbackShadow(host) {
    const root = host.shadowRoot;
    if (!root) return;
    Array.from(root.childNodes).forEach(n => {
      if (n.nodeName !== 'STYLE' && n.nodeName !== 'SLOT') host.appendChild(n);
    });
  }

  // 工具栏不是 init 事件那一刻就有节点的：TinyMCE 把 UI 渲染排在 init 之后，
  // 首次调用经常扑空。所以盯一次宿主容器的 childList，第一批节点进来就搬，
  // 再挂一个 3 秒的兜底（万一等到那时还没有，就放弃、保持原样）。
  function scheduleToolbarShadow(ed) {
    const host = document.getElementById('tcs-toolbar');
    if (!host) return;
    let done = false;
    const tryMount = async () => {
      if (done) return;
      if (await mountToolbarInShadow(ed)) done = true;
      if (done) { obs.disconnect(); clearTimeout(timer); }
    };
    const obs = new MutationObserver(() => { if (host.firstChild) tryMount(); });
    obs.observe(host, { childList: true });
    const timer = setTimeout(() => { obs.disconnect(); if (!done) tryMount(); }, 3000);
    if (host.firstChild) tryMount();
  }

  // ── 初始化 ───────────────────────────────────────────────────────────────
  registerPlugins();
  // 配置在搭壳之前就读完了（见上面「配置：必须在搭壳之前定下来」）。

  const sync = debounce(() => {
    port.postMessage({ action: 'syncContent', html: cleanContent() });
  }, SYNC_MS);

  // 初始化失败时 TinyMCE 不会派发 init 事件，于是“加载中”永远挂着。
  // 接住 init 的 Promise，再加一道看门狗，让失败至少有话说。
  const watchdog = setTimeout(() => {
    if (window.__tcsReady) return;
    banner(t('banner_not_ready'), '#c62828');
    console.warn('[BetterCompose] init 超时未就绪');
  }, 8000);

  const initRet = tmce.init({
    selector: '#tcs-content',
    inline: true,
    fixed_toolbar_container: '#tcs-toolbar',
    toolbar_persist: true,

    // 单行：menubar 关掉、sliding 让溢出项收进「更多」，不换行。
    // 顺序 / 分组 / 显示哪些按钮，全由配置里的 toolbar 决定，默认是这 18 个：
    //   菜单 → 撤销/重做 → 字体 字体大小 → 字体颜色 背景颜色
    //   → 删除线 格式刷 清除格式 → 左 中 右对齐 → 有序/无序列表
    //   → 表格 → 表情 → 源码
    // '|' 只是分组竖线，不改变顺序；组内顺序即按钮顺序。尾部的 表格 / 表情 /
    // 源码 各自单独成组：sliding 是**按组**往「更多」里收的，三个并成一组时
    // 930px 会一下子同时消失三个；分开后同样的宽度只少了表情 + 源码，表格还在
    // （代价是两根竖线约 16px）。
    menubar: false,
    toolbar_mode: 'sliding',
    toolbar: cfg.toolbar.join(' '),

    // 块格式：显示名 → 标签。TinyMCE 的默认值是
    // 'Paragraph=p;Heading 1=h1;…'，中文语言包把 Paragraph 译成「段落」；
    // 这里换成 blockFormats，默认第一项「正文文本」对应 div（见 config.js 里
    // defaults() 上面那段注释）。显示名按当前界面语言翻译。
    block_formats: cfg.blockFormats.map(([text, tag]) => text + '=' + tag).join(';'),

    // 新建段落 / 空文档使用哪个标签（TinyMCE 的 forced_root_block）。
    // 默认 'div'：与 TB 的「正文文本」一致 —— 按 Enter 新建的是 div，没有 p 的
    // margin，存出去也不再是每行一个 <p>。改成 'p' 就是回到 TB 的「段落」，
    // 想要真正的段间距时才这么配。
    forced_root_block: cfg.defaultBlockFormat,

    // 色板就是上面那份 PALETTE（22 色），和菜单里的「文字颜色」是同一组值。
    // 两个按钮是**拆分按钮**：主键套用上次的颜色、箭头开色板；命令 mceApplyTextcolor /
    // mceRemoveTextcolor、格式器 forecolor / hilitecolor 都在 TinyMCE 7 的核心与
    // silver 主题里，所以一个插件都不用加。
    // 11 格（黑白灰五档 + 红橙黄绿蓝紫）看着更克制，理由是「格子密了点不准」；
    // 实际用下来缺色比密度更碍事，所以按官方示例铺成 5 列 —— 22 个正好是 4 行
    // 加末行的黑/白，下面再接 TinyMCE 自己的「无 / 自定义」。色名一律走中文，
    // 理由同 PALETTE。
    color_map: PALETTE.flatMap(([text, hex]) => [hex, text]),

    // advlist：让 numlist / bullist 变成「拆分按钮」——主键套用默认样式，
    // 右箭头选列表样式（实心点 / 空心圆 / 方块，1. / a. / i. / A. / I.）。
    // 代价是每个列表按钮多出一个 chevron（约 20px），窄窗口下 table 更早被
    // 收进「更多」；功能优先，宽度不够时让 sliding 自己收尾部。
    // emoticons：表情选择器。用的是 TinyMCE 自带的 emoji 数据集，插入的是
    // **unicode 字符**而不是 <img> —— 邮件正文里带图要么被收件端当附件、
    // 要么被拦外链，而字符任何客户端都能显示（缺字时也只是豆腐块，不会破版）。
    // 数据库 190 KB，按需加载：插件在 init 后 fetch js/emojis.min.js，不点按钮
    // 之前不占启动时间。
    plugins:
      'advlist tcs_fp autolink lists link image charmap anchor emoticons ' +
      'searchreplace visualblocks code insertdatetime table wordcount fullscreen',

    // 只留邮件里真用得上的样式：default 之外，无序列表 disc/circle/square，
    // 有序列表 1. / a. / i. / A. / I.。希腊数字、亚美尼亚数字之类全砍掉。
    advlist_bullet_styles: 'default,disc,circle,square',
    advlist_number_styles: 'default,lower-alpha,lower-roman,upper-alpha,upper-roman',

    base_url: BASE,
    skin_url: BASE + '/skins/ui/oxide',
    suffix: '.min',
    license_key: 'gpl',
    promotion: false,
    branding: false,
    // 编辑器界面语言跟随配置（选项页「界面语言」）。英文是 TinyMCE 内置的，
    // 不传 language_url 就不会去拉文件；其余语言从包内 langs/ 取。
    // 注意 TinyMCE 的语言代码与 _locales 目录名并不总是一致（法语是 fr_FR），
    // 映射表在 tmLang 里。
    language: tmLang || 'en',
    ...(tmLang ? { language_url: BASE + '/langs/' + tmLang + '.js' } : {}),
    content_css: false,

    // ── 资源必须全部来自扩展包内，撰写窗口不允许任何外网依赖 ──────────────
    // base_url / skin_url / language_url 都是 moz-extension://…；插件的数据库也
    // 由 base_url 派生，走的是我们改写过的 ScriptLoader（fetch 扩展内文件）。
    // 唯一一个默认指向远端的选项是 emoticons_images_url ——
    // TinyMCE 7.9 的默认值是 https://cdnjs.cloudflare.com/…/twemoji/15.1.0/，
    // 只要数据库里的 char 是 <img>（官方 CDN 版数据就是），面板就会去拉图，
    // 断网/被墙时整片空白。这里钉成空串：永远用 unicode 字符渲染。
    emoticons_images_url: '',

    // inline 模式下的两处体验项
    inline_boundaries: true,       // 光标能走出 <b>/<a> 等行内元素，不会卡死在里面
    object_resizing: 'img,table',  // 图片/表格直接拖边框缩放，不弹对话框

    // TinyMCE 默认白名单会把 moz-do-not-send 删掉，必须显式放行。
    // code[style] 是给 markdown 粘贴用的：行内代码的等宽字体与浅灰底全在 style 里，
    // 默认 schema 对 code 上的 style 是否放行没有明确保证，这里钉死。
    extended_valid_elements:
      'img[src|alt|title|width|height|style|class|moz-do-not-send],' +
      'a[href|target|title|style|class],' +
      'code[style|class]',

    images_upload_handler: blobInfo => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.readAsDataURL(blobInfo.blob());
    }),
    file_picker_types: 'image',
    file_picker_callback: (cb, value, meta) => {
      if (meta.filetype !== 'image') return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => cb(reader.result, { alt: file.name });
        reader.readAsDataURL(file);
      };
      input.click();
    },
    paste_data_images: true,
    image_advtab: false,

    content_style:
      '#tcs-content{font:14px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif;' +
      'color:#1a1a1a;padding:2px 0;}' +
      '#tcs-content table{border-collapse:collapse;}' +
      '#tcs-content td,#tcs-content th{border:1px solid #c9c9c9;padding:4px 8px;}' +
      '#tcs-content img{max-width:100%;height:auto;}' +
      '#tcs-content blockquote{border-left:2px solid #d0d0d0;margin:8px 0;padding-left:10px;color:#555;}',

    setup(ed) {
      registerMenus(ed);
      registerToolbar(ed);
      patchColorPicker(ed);
      registerMarkdownPaste(ed);

      ed.on('init', () => {
        window.__tcsReady = true;
        clearTimeout(watchdog);

        const notice = document.getElementById('_tcs_notice');
        if (notice) notice.remove();

        const markUI = el => {
          if (el && el.nodeType === 1 &&
              (el.classList && (el.classList.contains('tox-tinymce-aux') ||
               el.classList.contains('tox-silver-sink')))) {
            el.setAttribute('data-tcs-ui', '1');
            el.contentEditable = 'false';
          }
        };
        document.querySelectorAll('.tox-tinymce-aux,.tox-silver-sink').forEach(markUI);
        new MutationObserver(muts => {
          muts.forEach(m => m.addedNodes.forEach(markUI));
        }).observe(document.body, { childList: true });

        markAllImages(ed.getBody());
        // 工具栏渲染完了：整棵子树立刻搬进 shadow root，别再等 —— 用户这一秒
        // 就可能按下保存。（失败时它保持原样，功能不受影响，只是草稿里会多出 UI）
        scheduleToolbarShadow(ed);
        ed.on('input change keyup paste SetContent NodeChange', () => {
          markAllImages(ed.getBody());
          sync();
        });

        // 字体 / 字号按钮显示当前值：选区一动、内容一改就得跟上。
        // NodeChange 触发很密（每次方向键都算），所以压一层 debounce ——
        // 标签只有一个文本节点，但没必要每个按键都读一次计算样式。
        refreshValueLabels(ed);
        setTimeout(() => refreshValueLabels(ed), 0);   // 工具栏才刚挂上，下一个 task 再兜一次
        const refreshLabels = debounce(() => refreshValueLabels(ed), 60);
        // SetContent 也在里面：回复 / 转发时正文是整块塞进来的，光标落在了
        // 引用原文里，三个"显示当前值"的按钮得跟着走，否则还挂着旧值。
        ed.on('NodeChange SelectionChange Input Undo Redo SetContent FormatApply', refreshLabels);

        window.__tcs = {
          editor: ed,
          content: () => cleanContent(),
          info: () => ({
            version: tmce.majorVersion + '.' + tmce.minorVersion,
            images: Array.from(ed.getBody().querySelectorAll('img')).map(i => ({
              src: (i.getAttribute('src') || '').slice(0, 60),
              dns: i.getAttribute(DNS_ATTR),
            })),
          }),
        };

        log('就绪，TinyMCE', tmce.majorVersion + '.' + tmce.minorVersion);
      });

      ed.on('LoadError', err => console.error('[BetterCompose] LoadError:', err));
    },
  });

  // TinyMCE 7 的 init 返回 Promise。同步返回（或返回 undefined）的版本也不会误报，
  // 因为 Promise.resolve 会把它摊平。
  Promise.resolve(initRet).then(
    () => clearTimeout(watchdog),
    err => {
      clearTimeout(watchdog);
      console.error('[BetterCompose] 初始化失败:', err);
      banner(t('banner_init_failed', [(err && err.message) || err]), '#c62828');
    }
  );
})().catch(err => {
  console.error('[BetterCompose] 主流程异常:', err);
  // 主流程中途抛错时横幅还在，别让它一直说“加载中”。
  // 这时候 i18n 可能都没加载成（错误就出在那一步），所以翻译函数不存在时
  // 退回英文原文 —— 这条提示本身就是用来报告失败的，不能自己先挂掉。
  try {
    const el = document.getElementById('_tcs_notice');
    if (el) {
      const msg = (err && err.message) || String(err);
      el.style.background = '#c62828';
      el.textContent = __tcsSay ? __tcsSay('banner_init_failed', [msg])
                                : 'BetterCompose failed to start: ' + msg + ' (click to dismiss)';
    }
  } catch (e) {}
});
