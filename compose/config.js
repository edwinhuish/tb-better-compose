/**
 * 写信增强 BetterCompose — 配置的单一来源
 *
 * 这里有三个使用方，所以必须独立成一个文件、且不碰 DOM / 不碰 browser API：
 *   1. 撰写窗口（composeScripts 注入，排在 inject.js 之前）
 *   2. 选项页（options.html 里 <script src="../compose/i18n.js"> + 这个文件）
 *   3. node 单测（tools/test-config.mjs，用 new Function('window', code) 装进来）
 *
 * 之前这些常量与校验都塞在 inject.js 的闭包里，选项页要校验「工具栏写错没」
 * 就只能抄一遍 —— 抄一遍的下场是两边迟早不一致，而配置这种事不一致表现为
 * 「选项页说没问题、编辑器里按钮却没了」，最难查。
 *
 * 界面文案一律走 t()：默认块格式的**显示名**是配置默认值的一部分，
 * 它跟着语言变（「正文文本」/ "Body text"），所以 defaults() 是函数不是常量，
 * 每次都要把翻译函数传进来。
 */

(function (root) {
  'use strict';

  const CONFIG_KEY = 'composeStudio.config';

  // 支持的语言：'auto' = 跟随 Thunderbird。其余既是 _locales 下的目录名，
  // 也是 TinyMCE 的 language 值（TinyMCE 里英文是内置的，没有语言文件）。
  // 加语言时才用的三件事：这个数组 + _locales/<code>/messages.json
  // + vendor/tinymce/langs/<code>.js（英文除外）。tools/check-i18n.mjs 会全部对上。
  const LANGUAGES = ['auto', 'en', 'zh_CN', 'zh_TW', 'ja', 'de', 'fr', 'es', 'ru'];

  // forced_root_block 只接受块级标签；给错值 TinyMCE 会静默变成 div 或直接
  // 把整篇正文塞进一个未知元素，保存出去的邮件就变形了 —— 在这里先挡掉。
  const BLOCK_TAGS = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote'];

  // 工具栏白名单：本包里真能渲染出东西的按钮（TinyMCE 7 核心 + silver +
  // 我们注册的自定义按钮 + 几个按钮组名）。不在这里的 token 一律丢弃 ——
  // 用户把 toolbar 写错时，宁可少几个按钮，也不要一条空工具栏。
  const KNOWN_BUTTONS = new Set([
    // 自定义
    'tcs_menu', 'tcs_font', 'tcs_size', 'tcs_block', 'tcs_fp', 'tcs_emoji',
    'tcs_align_l', 'tcs_align_c', 'tcs_align_r',
    // 核心 / silver 注册的按钮
    'undo', 'redo', 'bold', 'italic', 'underline', 'strikethrough',
    'subscript', 'superscript', 'cut', 'copy', 'paste', 'pastetext',
    'selectall', 'newdocument', 'removeformat',
    'alignleft', 'aligncenter', 'alignright', 'alignjustify', 'alignnone',
    'bullist', 'numlist', 'outdent', 'indent',
    'link', 'unlink', 'openlink', 'anchor', 'image', 'charmap', 'hr',
    'forecolor', 'backcolor', 'code', 'fullscreen', 'preview',
    'visualblocks', 'visualaid', 'searchreplace', 'insertdatetime',
    'ltr', 'rtl', 'blocks', 'fontfamily', 'fontsize', 'styles',
    'pagebreak', 'toc', 'help', 'emoticons',
    // 表格（table 既是组名，也是 toolbar 里展开整组的关键字）
    'table', 'tableprops', 'tabledelete', 'tablecellprops', 'tablemergecells',
    'tablesplitcells', 'tableinsertrowbefore', 'tableinsertrowafter',
    'tabledeleterow', 'tableinsertcolbefore', 'tableinsertcolafter',
    'tabledeletecol', 'tablesortrows',
    // 组名（'styles' 上面已经列过，这里只补 'align' —— 重复项在 Set 里不会报错，
    // 但读的人会以为漏了什么）
    'align',
  ]);

  // 工具栏默认值：Edwin 指定的那 18 个按钮，顺序有意义（sliding 按组
  // 往「更多」里收，尾部三组各自单独成组才不会被一起收走）。
  // 写成字面量而不是从别处算，是因为 tools/check-static.mjs 直接读它来核对
  // 「这些按钮名在 bundle 里真的存在」—— 唯一的字符串来源更好查。
  const TOOLBAR_DEFAULT =
    'tcs_menu | undo redo | tcs_font tcs_size | forecolor backcolor | ' +
    'strikethrough tcs_fp removeformat | tcs_align_l tcs_align_c tcs_align_r | ' +
    'numlist bullist | table | tcs_emoji | code';

  // 选项页「添加按钮」下拉的分组。只列常用项 —— 白名单里有 70 多个 token，
  // 全列出来是一堵墙，而且 fontfamily / fontsize 这类在 7 里是「弹窗输入」，
  // 邮件场景基本不用。要冷门按钮就手改 storage，白名单仍然放行。
  const BUTTON_GROUPS = [
    { title: 'grp_custom', items: [
      ['tcs_menu', 'btn_custom_menu'],
      ['tcs_font', 'btn_custom_font'],
      ['tcs_size', 'btn_custom_size'],
      ['tcs_block', 'btn_custom_block'],
      ['tcs_fp', 'btn_custom_painter'],
      ['tcs_emoji', 'btn_custom_emoji'],
      ['tcs_align_l', 'align_left'],
      ['tcs_align_c', 'align_center'],
      ['tcs_align_r', 'align_right'],
    ] },
    { title: 'grp_edit', items: [
      ['undo', 'btn_undo'],
      ['redo', 'btn_redo'],
      ['cut', 'clip_cut'],
      ['copy', 'clip_copy'],
      ['paste', 'clip_paste'],
      ['pastetext', 'btn_pastetext'],
      ['selectall', 'clip_select_all'],
      ['removeformat', 'fmt_clear'],
      ['searchreplace', 'menu_find_replace'],
    ] },
    { title: 'grp_format', items: [
      ['bold', 'fmt_bold'],
      ['italic', 'fmt_italic'],
      ['underline', 'fmt_underline'],
      ['strikethrough', 'fmt_strike'],
      ['forecolor', 'fmt_text_color'],
      ['backcolor', 'fmt_back_color'],
      ['subscript', 'btn_subscript'],
      ['superscript', 'btn_superscript'],
      ['blocks', 'btn_blocks'],
    ] },
    { title: 'grp_align', items: [
      ['alignleft', 'align_left'],
      ['aligncenter', 'align_center'],
      ['alignright', 'align_right'],
      ['alignjustify', 'btn_align_justify'],
    ] },
    { title: 'grp_list', items: [
      ['bullist', 'fmt_list_bullet'],
      ['numlist', 'fmt_list_number'],
      ['outdent', 'btn_outdent'],
      ['indent', 'btn_indent'],
    ] },
    { title: 'grp_insert', items: [
      ['table', 'menu_table'],
      ['link', 'ins_link'],
      ['image', 'ins_image'],
      ['charmap', 'ins_charmap'],
      ['anchor', 'ins_anchor'],
      ['hr', 'ins_hr'],
      ['insertdatetime', 'btn_datetime'],
      ['code', 'btn_code'],
      ['fullscreen', 'view_fullscreen'],
      ['visualblocks', 'view_blocks'],
      ['preview', 'btn_preview'],
    ] },
  ];

  // 默认值。t 是 i18n 的翻译函数，缺省时退回键名（不抛错 —— 配置读不出来
  // 不该拦住撰写窗口，最坏情况是块格式叫 block_body，但功能正常）。
  //
  // 「正文文本」为什么是 div 而不是 p：
  //   TB 自己的段落下拉（messengercompose.xhtml 里的 ParagraphSelect）里两行是
  //     <menuitem id="toolbarmenu_bodyText"     label="正文文本" value=""/>
  //     <menuitem id="toolbarmenu_paragraph"    label="段落"     value="p"/>
  //   value="" 走的是 editor.js 的
  //     if (state === "") goDoCommandParams("cmd_paragraphState", "");
  //   注释原话是「Corresponds to body text. Has no corresponding formatBlock value.」
  //   —— 也就是**没有块格式**。这时换行由 Gecko 的 editor.defaultParagraphSeparator
  //   决定，默认值就是 div，所以正文里是 <div> 而不是 <p>。
  // 给 forced_root_block 传 'p' 的话每封信都会变成「段落」：TB 下拉识别成 p，
  // 行与行之间还多出 p 的 margin。
  function defaults(t) {
    const tr = typeof t === 'function' ? t : k => k;
    const pairs = [
      [tr('block_body'), 'div'],
      [tr('block_paragraph'), 'p'],
      [tr('block_heading', ['1']), 'h1'],
      [tr('block_heading', ['2']), 'h2'],
      [tr('block_heading', ['3']), 'h3'],
      [tr('block_heading', ['4']), 'h4'],
      [tr('block_heading', ['5']), 'h5'],
      [tr('block_heading', ['6']), 'h6'],
      [tr('block_pre'), 'pre'],
    ];
    return {
      toolbar: TOOLBAR_DEFAULT,
      blockFormats: pairs.map(([text, tag]) => text + '=' + tag).join(';'),
      defaultBlockFormat: 'div',
      markdownPaste: true,
      language: 'auto',
      debug: false,
    };
  }

  // 解析块格式清单：字符串与数组两种写法都吃，非法标签直接丢。
  function parseBlockFormats(value, t) {
    let pairs = [];
    if (Array.isArray(value)) {
      pairs = value.map(it =>
        Array.isArray(it) ? [String(it[0] || ''), String(it[1] || '')]
                          : [String(it), String(it)]);
    } else if (typeof value === 'string') {
      pairs = value.split(';').map(s => s.trim()).filter(Boolean).map(s => {
        const at = s.indexOf('=');
        return at < 0 ? [s, s] : [s.slice(0, at).trim(), s.slice(at + 1).trim()];
      });
    }
    const kept = pairs
      .map(([text, tag]) => [text, tag.toLowerCase()])
      .filter(([text, tag]) => text && BLOCK_TAGS.includes(tag));
    if (kept.length) return kept;
    // 全非法（或压根没给）：回退默认，绝不让编辑器没有块格式
    return parseBlockFormats(defaults(t).blockFormats, t);
  }

  // 工具栏语法清理：去空 token、去首尾与连续的 '|'、丢未知按钮。
  // 清完之后一个按钮都不剩就回退默认 —— 这是"配置写错也要能正常用"的底线。
  function normalizeToolbar(value) {
    const raw = Array.isArray(value) ? value.join(' ')
              : (typeof value === 'string' ? value : '');
    const tokens = raw.split(/\s+/).filter(Boolean);
    const out = [];
    const unknown = [];
    tokens.forEach(token => {
      if (token === '|') {
        if (out.length && out[out.length - 1] !== '|') out.push('|');
        return;
      }
      if (KNOWN_BUTTONS.has(token)) out.push(token);
      else unknown.push(token);
    });
    while (out.length && out[out.length - 1] === '|') out.pop();
    if (unknown.length) {
      console.warn('[BetterCompose] toolbar 里有不认识的按钮，已忽略：' + unknown.join(' '));
    }
    if (out.length) return out;
    return TOOLBAR_DEFAULT.split(/\s+/).filter(token => token && token !== '|');
  }

  // 布尔配置的宽容解析：storage 里可能是 true / "true" / 1 / "on" 都算开。
  // 认不出来就退回默认值 —— 配置写错不该让功能行为变得不可预测。
  function asBool(value, def) {
    if (value === undefined || value === null || value === '') return def;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return def;
  }

  // 语言只认白名单里的；写错（包括大小写、'zh-CN' 这种连字符写法）一律回 auto。
  function normalizeLanguage(value) {
    const s = String(value == null ? '' : value).trim();
    if (LANGUAGES.includes(s)) return s;
    const alias = { 'zh-cn': 'zh_CN', 'zh_cn': 'zh_CN', 'zh-tw': 'zh_TW',
                    'zh_hk': 'zh_TW', 'zh': 'zh_CN' }[s.toLowerCase()];
    if (alias) return alias;
    if (s && s !== 'auto') {
      console.warn('[BetterCompose] 不支持的语言，已回退 auto：' + s);
    }
    return 'auto';
  }

  // 全部键过一遍校验，返回**可直接交给 TinyMCE 与 UI** 的形状。
  function normalize(raw, t) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const def = defaults(t);
    const blockFormats = parseBlockFormats(
      src.blockFormats === undefined ? def.blockFormats : src.blockFormats, t);

    const tags = blockFormats.map(([, tag]) => tag);
    let root = String(src.defaultBlockFormat || def.defaultBlockFormat).trim().toLowerCase();
    if (!tags.includes(root)) {
      if (src.defaultBlockFormat !== undefined) {
        console.warn('[BetterCompose] defaultBlockFormat 不在 blockFormats 里，回退 ' +
          (tags.includes('div') ? 'div' : tags[0]));
      }
      // 回退优先 div：「正文文本」是 TB 的默认体验，也是邮件里最不容易出事的块。
      root = tags.includes('div') ? 'div' : tags[0];
    }

    return {
      blockFormats,
      defaultBlockFormat: root,
      toolbar: normalizeToolbar(
        src.toolbar === undefined ? def.toolbar : src.toolbar),
      markdownPaste: asBool(
        src.markdownPaste === undefined ? def.markdownPaste : src.markdownPaste,
        def.markdownPaste),
      language: normalizeLanguage(src.language === undefined ? def.language : src.language),
      debug: asBool(src.debug === undefined ? def.debug : src.debug, def.debug),
    };
  }

  // 只留下「和默认值不同」的键。选项页保存时用：默认块格式的名字是跟着语言
  // 变的，如果把默认值也写进 storage，用户以后换界面语言时那串名字就冻在
  // 旧语言里了。一个键都没改就返回 {}，storage 里等于清空覆盖。
  function diff(cfg, t) {
    const def = defaults(t);
    const patch = {};
    if (cfg.toolbar.join(' ') !== normalizeToolbar(def.toolbar).join(' ')) {
      patch.toolbar = cfg.toolbar.join(' ');
    }
    const defBlocks = parseBlockFormats(def.blockFormats, t)
      .map(([text, tag]) => text + '=' + tag).join(';');
    const curBlocks = cfg.blockFormats.map(([text, tag]) => text + '=' + tag).join(';');
    if (curBlocks !== defBlocks) patch.blockFormats = curBlocks;
    if (cfg.defaultBlockFormat !== def.defaultBlockFormat) {
      patch.defaultBlockFormat = cfg.defaultBlockFormat;
    }
    if (cfg.markdownPaste !== def.markdownPaste) patch.markdownPaste = cfg.markdownPaste;
    if (cfg.language !== def.language) patch.language = cfg.language;
    if (cfg.debug !== def.debug) patch.debug = cfg.debug;
    return patch;
  }

  root.__tcsConfig = {
    CONFIG_KEY,
    LANGUAGES,
    BLOCK_TAGS,
    KNOWN_BUTTONS,
    TOOLBAR_DEFAULT,
    BUTTON_GROUPS,
    defaults,
    parseBlockFormats,
    normalizeToolbar,
    asBool,
    normalizeLanguage,
    normalize,
    diff,
  };
})(typeof window !== 'undefined' ? window : globalThis);
