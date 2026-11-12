/**
 * 写信增强 BetterCompose — 字体候选表与「系统里到底装了哪些」的探测
 *
 * 为什么需要这个文件：Gecko 没有枚举系统字体的 API。
 *   · document.fonts 只列**用 @font-face 加载过**的字，系统字体一个都不在里面；
 *   · navigator.fonts.query()（Local Font Access）是 Chromium 的，要权限 + 用户手势，
 *     Thunderbird 没有实现；
 *   · 真正能拿到全表的是 nsIFontEnumerator.EnumerateAllFonts()（TB 自己的字体菜单
 *     用的就是它，见 messengercompose/editor.js），但那是 chrome 特权组件，扩展够到它
 *     只能走 experiment_apis，而那个又要求特权签名 / 系统内置附加组件 ——
 *     官方发行的 TB 里连 extensions.experiments.enabled 都被硬编码成 false。
 *
 * 所以只能"点名验证"：候选表 + 量字宽，问系统"这个族到底有没有"。这份文件管两件事：
 *   1. SCAN_LIST —— 尽可能全的候选族名（含通用族），选项页的「扫描系统字体」就是
 *      把它整表问一遍；
 *   2. detect() —— 量字宽的探测本身，撰写窗口和选项页共用（同一个实现，不会两边
 *      给出不同答案）。
 *
 * 不碰 DOM、不碰 browser API（detect 只要求传一个 document 进来），
 * 所以能像 config.js / markdown.js 一样被 node 直接装进来测。
 */
(function (root) {
  'use strict';

  // 探测用的测试串：必须同时有中日韩字和西文。
  //   · 只测西文 → "装了但只带西文字形"的字体会被误判成装了（中文其实会回退）；
  //   · 只测中文 → 纯西文字体会被误判成没装。
  const PROBE_TEXT = 'mmWWi1lL@# 中文测试 日本語';

  // 量宽度时对照的三种通用族。任何一种宽度不同，就说明候选族真的被用上了。
  const GENERIC = ['monospace', 'serif', 'sans-serif'];

  // 候选表：[族名, 通用族]。族名就是 CSS / fontconfig 里的名字 —— 写错不会报错，
  // 只是永远探不到、也就不会出现在菜单里，所以宁可按各家系统的真实拼写抄全。
  // 通用族的作用是兜底：收件端没有这个字时按同类回退，而不是掉到它的默认字体上。
  const SCAN_LIST = [
    // ── 中文 / 日文 / 韩文 ──
    ['SimSun', 'serif'], ['NSimSun', 'monospace'], ['SimHei', 'sans-serif'],
    ['Microsoft YaHei', 'sans-serif'], ['Microsoft YaHei UI', 'sans-serif'],
    ['Microsoft JhengHei', 'sans-serif'], ['KaiTi', 'serif'], ['FangSong', 'serif'],
    ['DengXian', 'sans-serif'], ['DFKai-SB', 'serif'], ['MingLiU', 'serif'],
    ['PMingLiU', 'serif'], ['MingLiU-ExtB', 'serif'], ['SimSun-ExtB', 'serif'],
    ['PingFang SC', 'sans-serif'], ['PingFang TC', 'sans-serif'],
    ['Hiragino Sans GB', 'sans-serif'], ['Hiragino Sans', 'sans-serif'],
    ['Songti SC', 'serif'], ['Songti TC', 'serif'], ['Kaiti SC', 'serif'],
    ['STHeiti', 'sans-serif'], ['Heiti SC', 'sans-serif'], ['STSong', 'serif'],
    ['STFangsong', 'serif'], ['Apple LiGothic', 'sans-serif'], ['AppleGothic', 'sans-serif'],
    ['Apple SD Gothic Neo', 'sans-serif'],
    ['Noto Sans CJK SC', 'sans-serif'], ['Noto Sans CJK TC', 'sans-serif'],
    ['Noto Sans CJK JP', 'sans-serif'], ['Noto Sans CJK KR', 'sans-serif'],
    ['Noto Serif CJK SC', 'serif'], ['Noto Serif CJK TC', 'serif'],
    ['Noto Serif CJK JP', 'serif'], ['Noto Serif CJK KR', 'serif'],
    ['Source Han Sans SC', 'sans-serif'], ['Source Han Serif SC', 'serif'],
    ['WenQuanYi Micro Hei', 'sans-serif'], ['WenQuanYi Zen Hei', 'sans-serif'],
    ['AR PL UMing CN', 'serif'], ['AR PL UKai CN', 'serif'],
    ['Droid Sans Fallback', 'sans-serif'],
    ['Meiryo', 'sans-serif'], ['Meiryo UI', 'sans-serif'], ['Yu Gothic', 'sans-serif'],
    ['Yu Gothic UI', 'sans-serif'], ['Yu Mincho', 'serif'], ['MS Gothic', 'sans-serif'],
    ['MS PGothic', 'sans-serif'], ['MS Mincho', 'serif'], ['MS PMincho', 'serif'],
    ['Malgun Gothic', 'sans-serif'], ['NanumGothic', 'sans-serif'],

    // ── 西文：三平台都常见的 ──
    ['Arial', 'sans-serif'], ['Arial Black', 'sans-serif'], ['Arial Narrow', 'sans-serif'],
    ['Helvetica', 'sans-serif'], ['Helvetica Neue', 'sans-serif'],
    ['Verdana', 'sans-serif'], ['Tahoma', 'sans-serif'], ['Trebuchet MS', 'sans-serif'],
    ['Calibri', 'sans-serif'], ['Calibri Light', 'sans-serif'], ['Candara', 'sans-serif'],
    ['Corbel', 'sans-serif'], ['Segoe UI', 'sans-serif'], ['Segoe Print', 'sans-serif'],
    ['Segoe Script', 'sans-serif'], ['Franklin Gothic Medium', 'sans-serif'],
    ['Century Gothic', 'sans-serif'], ['Gill Sans', 'sans-serif'], ['Futura', 'sans-serif'],
    ['Avenir', 'sans-serif'], ['Avenir Next', 'sans-serif'], ['Optima', 'sans-serif'],
    ['Lucida Grande', 'sans-serif'], ['Lucida Sans Unicode', 'sans-serif'],
    ['Geneva', 'sans-serif'], ['Skia', 'sans-serif'], ['Chalkboard', 'sans-serif'],
    ['Comic Sans MS', 'sans-serif'], ['Impact', 'sans-serif'], ['Papyrus', 'sans-serif'],
    ['Rockwell', 'serif'],
    ['Times New Roman', 'serif'], ['Times', 'serif'], ['Georgia', 'serif'],
    ['Cambria', 'serif'], ['Constantia', 'serif'], ['Garamond', 'serif'],
    ['Palatino', 'serif'], ['Palatino Linotype', 'serif'], ['Book Antiqua', 'serif'],
    ['Baskerville', 'serif'], ['Didot', 'serif'], ['Bodoni 72', 'serif'],
    ['Cochin', 'serif'], ['Hoefler Text', 'serif'], ['Caslon', 'serif'],
    ['Courier New', 'monospace'], ['Courier', 'monospace'], ['Consolas', 'monospace'],
    ['Menlo', 'monospace'], ['Monaco', 'monospace'], ['Lucida Console', 'monospace'],
    ['Andale Mono', 'monospace'], ['Cascadia Code', 'monospace'], ['Cascadia Mono', 'monospace'],

    // ── Linux 发行版自带的 ──
    ['DejaVu Sans', 'sans-serif'], ['DejaVu Serif', 'serif'], ['DejaVu Sans Mono', 'monospace'],
    ['Liberation Sans', 'sans-serif'], ['Liberation Serif', 'serif'],
    ['Liberation Mono', 'monospace'], ['FreeSans', 'sans-serif'], ['FreeSerif', 'serif'],
    ['FreeMono', 'monospace'], ['Nimbus Sans', 'sans-serif'], ['Nimbus Roman', 'serif'],
    ['Nimbus Mono PS', 'monospace'], ['URW Bookman', 'serif'],
    ['Carlito', 'sans-serif'], ['Caladea', 'serif'],
    ['Ubuntu', 'sans-serif'], ['Ubuntu Mono', 'monospace'], ['Ubuntu Condensed', 'sans-serif'],
    ['Cantarell', 'sans-serif'], ['Droid Sans', 'sans-serif'], ['Droid Serif', 'serif'],
    ['Noto Sans', 'sans-serif'], ['Noto Serif', 'serif'], ['Noto Sans Mono', 'monospace'],
    ['Noto Color Emoji', 'sans-serif'], ['Symbola', 'sans-serif'],
    ['Bitstream Vera Sans', 'sans-serif'], ['Bitstream Vera Serif', 'serif'],
    ['Bitstream Vera Sans Mono', 'monospace'],

    // ── 用户自己装的（设计/编码圈常见） ──
    ['Inter', 'sans-serif'], ['Roboto', 'sans-serif'], ['Roboto Mono', 'monospace'],
    ['Open Sans', 'sans-serif'], ['Noto Sans Display', 'sans-serif'],
    ['Lato', 'sans-serif'], ['Montserrat', 'sans-serif'], ['Source Sans Pro', 'sans-serif'],
    ['Fira Sans', 'sans-serif'], ['Fira Mono', 'monospace'], ['Fira Code', 'monospace'],
    ['JetBrains Mono', 'monospace'], ['IBM Plex Sans', 'sans-serif'],
    ['IBM Plex Mono', 'monospace'], ['Hack', 'monospace'], ['Inconsolata', 'monospace'],
    ['Anonymous Pro', 'monospace'],
  ];

  // 跨平台等价字：只给几条中文。收件端（macOS / 手机）经常没有 "SimSun"，
  // 只写单一族名就会掉回它自己的默认字体，看起来像"字体没生效"。
  const STACKS = {
    'simsun': 'SimSun, "Songti SC", "Noto Serif CJK SC", serif',
    'microsoft yahei': '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    'simhei': 'SimHei, "Heiti SC", "Noto Sans CJK SC", sans-serif',
    'kaiti': 'KaiTi, "Kaiti SC", "Noto Serif CJK SC", serif',
  };

  // 按钮上的短标签：工具栏要显示当前值，"Times New Roman" 这种全名会把单行
  // 工具栏撑开（TinyMCE 按初始文案把宽度量死了）。没列出来的就用族名本身。
  const SHORT = {
    'times new roman': 'Times',
    'courier new': 'Courier',
    'trebuchet ms': 'Trebuchet',
    'microsoft yahei': 'YaHei',
    'microsoft yahei ui': 'YaHei',
    'helvetica neue': 'Helvetica',
    'segoe ui': 'Segoe',
    'segoe script': 'Segoe',
    'segoe print': 'Segoe',
    'noto sans cjk sc': 'Noto Sans',
    'noto serif cjk sc': 'Noto Serif',
    'source han sans sc': 'Source Han',
    'source han serif sc': 'Source Han',
    'wenquanyi micro hei': 'WQY Micro',
    'wenquanyi zen hei': 'WQY Zen',
    'ar pl uming cn': 'UMing',
    'ar pl ukai cn': 'UKai',
    'droid sans fallback': 'Droid',
    'jetbrains mono': 'JetBrains',
    'ibm plex sans': 'IBM Plex',
    'ibm plex mono': 'IBM Plex',
    'bitstream vera sans': 'Vera Sans',
    'bitstream vera serif': 'Vera Serif',
    'palatino linotype': 'Palatino',
    'lucida sans unicode': 'Lucida Sans',
    'lucida console': 'Lucida Console',
    'franklin gothic medium': 'Franklin',
    'cascadia code': 'Cascadia',
    'cascadia mono': 'Cascadia',
    'ubuntu condensed': 'Ubuntu Cond',
    'noto sans display': 'Noto Sans',
    'source sans pro': 'Source Sans',
    'anonymous pro': 'Anonymous',
    'nanumgothic': 'Nanum',
  };

  // 不扫描也固定出现在菜单里的几条（顺序有意义）：最常用的那几个。
  // 其余全靠选项页的「扫描系统字体」把它们从 SCAN_LIST 里挖出来。
  const CURATED = [
    'SimSun', 'Microsoft YaHei', 'SimHei', 'KaiTi',
    'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia',
  ];

  const scanMap = new Map();
  SCAN_LIST.forEach(([name, generic]) => {
    if (!scanMap.has(name.toLowerCase())) scanMap.set(name.toLowerCase(), generic);
  });

  const key = name => String(name || '').trim().toLowerCase();

  // 通用族：候选表里的那一列；表外（用户自己填的）猜一个 —— 猜不到的按 sans-serif，
  // 这是最不容易"看起来不一样"的兜底。
  function genericOf(name) {
    const hit = scanMap.get(key(name));
    if (hit) return hit;
    if (/mono|consol|courier|code|terminal|fixed/i.test(name)) return 'monospace';
    if (/serif|times|georgia|song|ming|mincho|roman|garamond|palatino|baskerville/i.test(name)) {
      return 'serif';
    }
    return 'sans-serif';
  }

  // 写进 style 的 font-family 串：有跨平台等价字就用那一串，否则「族名, 通用族」
  function stackOf(name) {
    return STACKS[key(name)] || name + ', ' + genericOf(name);
  }

  const shortOf = name => SHORT[key(name)] || name;

  /**
   * 问系统"这些族到底装没装"。
   *
   * 老办法：同一串字符，用「候选族, 通用族」渲染一次、只用通用族渲染一次，
   * 宽度不一样就说明候选族真的被用上了。三种通用族都试，任意一种不同即算装了 ——
   * 只比"自己那一档通用族"会漏：系统把 sans-serif 直接指向 DejaVu Sans 时，
   * `DejaVu Sans, sans-serif` 和 `sans-serif` 一样宽，会被判成没装（实测踩过）。
   *
   * 去重：宽度签名（三种通用族下的宽度）完全相同的候选，说明系统把它们解析成了
   * 同一套字形 —— Linux 上 fontconfig 的 metric alias 就是这样（Arial → Liberation
   * Sans，SimSun → 某个明体）。这种只保留**候选表里靠前**的那个名字：邮件里写
   * `Arial` 比写 `Liberation Sans` 通用得多，收件端该有 Arial 的自然就有了。
   *
   * @param {Document} doc  用哪个文档量（撰写窗口 / 选项页都行）
   * @param {Array} list    [[族名, 通用族], …]；缺通用族时用 genericOf 兜
   * @returns {string[]}    真的装了的族名（保持传入顺序，已去重）
   */
  function detect(doc, list) {
    const entries = (list || SCAN_LIST)
      .map(item => (Array.isArray(item) ? item : [item]))
      .filter(item => item[0])
      .map(item => [item[0], item[1] || genericOf(item[0])]);

    const host = doc.body || doc.documentElement;
    const box = doc.createElement('div');
    // visibility:hidden 仍然参与布局（display:none 才不参与），所以量得到宽度
    box.style.cssText = 'position:absolute;left:-99999px;top:0;font-size:36px;' +
      'white-space:nowrap;visibility:hidden;';
    const make = family => {
      const s = doc.createElement('span');
      s.textContent = PROBE_TEXT;
      if (family) s.style.fontFamily = family;
      box.appendChild(s);
      return s;
    };

    // 一次把所有要量的串建好、一次性读宽度：每读一次 getBoundingClientRect 都会
    // 强制一次布局，逐个改字号逐个读的话 150 条 × 3 档要 0.5 秒；批量只有一次布局。
    const baseSpans = GENERIC.map(g => make(g));
    const spans = entries.map(([name]) => {
      // 族名可能自带引号（"Microsoft YaHei"），原样拼回去
      const first = String(name).split(',')[0].trim();
      return GENERIC.map(g => make(first + ', ' + g));
    });

    let installed = [];
    try {
      host.appendChild(box);
      const base = baseSpans.map(s => s.getBoundingClientRect().width);
      const seen = new Set();
      entries.forEach(([name], i) => {
        const widths = spans[i].map(s => s.getBoundingClientRect().width);
        const hit = widths.some((w, n) => Math.abs(w - base[n]) > 0.5);
        if (!hit) return;
        const signature = widths.map(w => Math.round(w * 10)).join('/');
        if (seen.has(signature)) return;      // 同一套字形，前面那个名字留下
        seen.add(signature);
        installed.push(name);
      });
    } finally {
      box.remove();
    }
    return installed;
  }

  root.__tcsFonts = {
    PROBE_TEXT,
    GENERIC,
    SCAN_LIST,
    STACKS,
    SHORT,
    CURATED,
    genericOf,
    stackOf,
    shortOf,
    detect,
  };
})(typeof window !== 'undefined' ? window : globalThis);
