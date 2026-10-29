#!/usr/bin/env node
/**
 * 静态校验：不启动 Thunderbird 也能抓掉大部分必然出错的配置。
 *
 * 检查项：
 *  1. manifest.json 可解析、引用到的文件都存在
 *  2. inject.js 里 plugins 列表对应的目录都在
 *  3. toolbar 上的自定义按钮都在 registry 里注册过（含 tcs_align_l/c/r 这类带下划线的）
 *  4. 菜单/工具栏用到的 execCommand 命令名，确实存在于打包进来的插件里
 *  5. 用到的 icon 名在 icons.min.js 里存在（写错的 icon 会被静默忽略）
 *  6. 我们自己的代码里不出现外网地址，且关键资源项都指向扩展包内
 *
 * 名字与 npm 命令对齐：`npm run check:static` 跑的就是 check-static.mjs。
 * （原名 verify.mjs —— 文件叫 verify、命令叫 check:static，同一件事两套词，
 * 查问题时得先在心里翻译一次。）
 *
 * 原先是 tools/verify.py（python3）。换成 node 是因为项目里全部工具都走
 * node —— 打包（tools/build-xpi.mjs）、回归（.harness/）都在 node 上，
 * 少一套运行时少一个「这台机器没装 python」的失败面。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TINYMCE_DIR, ensureTinymce, readWhitelist } from './extract-tinymce.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
ensureTinymce(ROOT);
let ok = true;

const fail = msg => { ok = false; console.log('  FAIL', msg); };
// 项目根就是包根：扩展自己的文件（manifest、compose/、options/…）都在根上，
// 仓库级的（package.json、tools/）也在一层，所以读什么都从 ROOT 起。
const read = p => readFileSync(join(ROOT, p), 'utf8');
const existsIn = p => existsSync(join(ROOT, p));
const section = t => console.log('\n' + t);
// TinyMCE 在仓库根的 vendor/tinymce 下（也就是包内那一份）。
const readTm = p => readFileSync(join(ROOT, TINYMCE_DIR, p), 'utf8');

// ── 1. manifest ──────────────────────────────────────────────────────────
section('[1] manifest');
const mf = JSON.parse(read('manifest.json'));
for (const icon of Object.values(mf.icons || {})) {
  if (!existsIn(icon)) fail('icon 不存在: ' + icon);
}
for (const js of (mf.background && mf.background.scripts) || []) {
  if (!existsIn(js)) fail('background 脚本不存在: ' + js);
}
console.log('  name:', mf.name, '| version:', mf.version, '| permissions:', mf.permissions);

const inject = read('compose/inject.js');
const config = read('compose/config.js');

// ── 2. plugins ───────────────────────────────────────────────────────────
section('[2] plugins');
const { plugins } = readWhitelist(ROOT);
for (const p of plugins) {
  // 装配树里的 TinyMCE 是「上次 postinstall」铺的：改过 inject.js 的 plugins 之后
  // 没重新 npm ci，就会在这里露出来（包能打出来，但编辑器里插件静默失效）。
  if (!existsSync(join(ROOT, TINYMCE_DIR, 'plugins', p, 'plugin.min.js'))) {
    fail(`插件没进 ${TINYMCE_DIR}: ${p}（改过 inject.js 之后重新 npm ci）`);
  }
}
console.log('  ', plugins.length, '个插件:', plugins.join(' '));

// ── 3. 工具栏按钮都有出处 ─────────────────────────────────────────────────
section('[3] 工具栏按钮');
// 工具栏内容由配置决定（init 里是 toolbar: cfg.toolbar.join(' ')），
// 默认值后来挪进了 compose/config.js 的 TOOLBAR_DEFAULT。所以这里改成
// 从 config.js 里抓 —— 抓的还是**会不会真的渲染出来**的那份默认值，自证能力没丢：
// 把 TOOLBAR_DEFAULT 里的 forecolor 改成 forecolr，这一步照样 FAIL。
const toolbarMatch = config.match(/const TOOLBAR_DEFAULT =\s*([\s\S]*?);\n/);
const toolbarText = (toolbarMatch ? toolbarMatch[1].match(/'([^']*)'/g) || [] : [])
  .map(s => s.slice(1, -1)).join('');
if (!toolbarText) fail('没能从 compose/config.js 里读到 TOOLBAR_DEFAULT');
// 竖线是分组符，不是按钮
const toolbarTokens = toolbarText.split(/[|\s]+/).filter(Boolean);
const customNames = [...new Set(toolbarTokens.filter(t => t.startsWith('tcs_')))];

for (const n of customNames) {
  const registered = inject.includes(`addButton('${n}`) ||
                     inject.includes(`addMenuButton('${n}`) ||
                     inject.includes(`addToggleButton('${n}`);
  // 平铺按钮是循环里注册的：addToggleButton(name, …)，name 来自数组字面量
  const loopRegistered = new RegExp(`\\['${n}'`).test(inject);
  if (!registered && !loopRegistered) fail('toolbar 引用了未注册的按钮: ' + n);
}

// 内置按钮（forecolor / backcolor / strikethrough …）由核心与 silver 主题注册，
// 我们只写名字。名字写错、或换了个构建里压根没有这个按钮时，表现是「按钮凭空
// 消失」—— 在 harness 里会被顺序断言一并判 FAIL，但原因藏在一长串输出里。
// 这里直接对着 bundle 查一次，把话说清楚。
const bundleParts = [readTm('tinymce.min.js'), readTm('themes/silver/theme.min.js')];
const walkPlugins = dir => {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir + '/' + name;
    if (statSync(join(ROOT, rel)).isDirectory()) walkPlugins(rel);
    else if (name.endsWith('.min.js')) bundleParts.push(readFileSync(join(ROOT, rel), 'utf8'));
  }
};
walkPlugins(TINYMCE_DIR + '/plugins');
const bundle = bundleParts.join('\n');

for (const t of toolbarTokens) {
  if (t.startsWith('tcs_')) continue;
  const quoted = bundle.includes(`"${t}"`) || bundle.includes(`'${t}'`);
  // 少数内置按钮是 addButton("name" 之外的形式注册的，兜一层 addButton/addToggleButton
  if (!quoted && !bundle.includes(`addButton("${t}`) && !bundle.includes(`addToggleButton("${t}`)) {
    fail('工具栏里的内置按钮在 bundle 里找不到: ' + t);
  }
}
console.log('  ', toolbarTokens.length, '个按钮:', toolbarTokens.join(' '));

// ── 4. 命令名 ────────────────────────────────────────────────────────────
section('[4] execCommand 命令');
const cmds = new Set([...inject.matchAll(/run\('([^']+)'\)/g)].map(m => m[1]));

// 命令可能写成 "Cmd"、'Cmd'、addCommands({Cmd: …})，也可能像 "Cut,Copy,Paste" 这样合并成一个键
const cmdKeys = new Set();
for (const m of bundle.matchAll(/"([A-Za-z][A-Za-z,]+)"/g)) {
  for (const k of m[1].split(',')) cmdKeys.add(k);
}
for (const m of bundle.matchAll(/\b([A-Z][A-Za-z]+)\s*:/g)) cmdKeys.add(m[1]);

for (const c of [...cmds].sort()) {
  if (!cmdKeys.has(c)) fail('命令在 core/插件里找不到: ' + c);
}
console.log('  ', cmds.size, '个命令:', [...cmds].sort().join(' '));

// ── 5. icon 名 ───────────────────────────────────────────────────────────
section('[5] icon 名');
const icons = readTm('icons/default/icons.min.js');

/**
 * 取出 item(...) / group(...) 的顶层参数列表。
 *
 * 不能用正则配 [^()]*：菜单项里会嵌 () => ed.formatter.apply('forecolor', …)
 * 这种多层调用，正则会截断并抓错末位字符串。这里按括号配平扫。
 */
function callArgs(src, fname) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`\\b(?:${fname})\\(`, 'g'))) {
    let i = m.index + m[0].length;
    let depth = 1, arg = '', args = [], quote = null;
    while (i < src.length && depth) {
      const ch = src[i];
      if (quote) {
        arg += ch;
        if (ch === quote && src[i - 1] !== '\\') quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
        arg += ch;
      } else if ('([{'.includes(ch)) {
        depth++; arg += ch;
      } else if (')]}'.includes(ch)) {
        depth--;
        if (depth) arg += ch;
      } else if (ch === ',' && depth === 1) {
        args.push(arg.trim());
        arg = '';
      } else {
        arg += ch;
      }
      i++;
    }
    args.push(arg.trim());
    out.push(args);
  }
  return out;
}

// 图标名有两种写法：menuitem 字面量里的 icon: 'x'，
// 以及 item(...)/group(...) 的第三参数（写成 item('粗体', run('Bold'), 'bold')，
// 图标名不以 icon: 出现，要单独抓）。
const menuIcons = new Set();
for (const fname of ['item', 'group']) {
  for (const args of callArgs(inject, fname)) {
    if (args.length < 3) continue;
    const last = fname === 'item' ? args[2] : args[args.length - 1];
    if (/^'[a-z0-9-]+'$/.test(last)) menuIcons.add(last.slice(1, -1));
  }
}
const usedIcons = new Set([
  ...[...inject.matchAll(/icon:\s*'([a-z0-9-]+)'/g)].map(m => m[1]),
  ...menuIcons,
]);

for (const name of [...usedIcons].sort()) {
  const hit = new RegExp(`\\b${name.replace(/[-]/g, '\\-')}\\s*:`).test(icons) ||
              icons.includes(`"${name}"`);
  if (!hit) fail('icon 不存在: ' + name);
}
console.log('  检查', usedIcons.size, '个');

// ── 6. 资源必须全在扩展包内 ──────────────────────────────────────────────
// 撰写窗口里任何一个 http(s) 请求都可能因为断网/被墙让编辑器停在「加载中」，
// 所以这里把「代码里出现外网地址」当成失败，而不是等它上线后才发现。
section('[6] 零外链');
// manifest 里的 homepage_url / developer.url 是展示用的元数据（附加组件管理器
// 上那个「主页」链接），运行期不会被加载。这条检查针对的是「运行时去外网拿
// 资源」，所以只放行这两个键，别的照旧。
const META_LINK = /^\s*"(homepage_url|url)"\s*:/;
const OUR_FILES = ['manifest.json', 'background.js', 'compose/config.js',
                   'compose/i18n.js', 'compose/inject.js', 'compose/markdown.js',
                   'compose/shell.css', 'options/options.html', 'options/options.js',
                   'options/options.css'];
for (const f of OUR_FILES) {
  const src = read(f);
  src.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (f === 'manifest.json' && META_LINK.test(line)) return;
    const m = t.match(/https?:\/\/[^\s'"`)]+/);
    if (m) fail(`${f}:${i + 1} 出现外网地址 ${m[0]}`);
  });
}

// 关键资源项：写死成 BASE（moz-extension://…）或明确关掉
const localRules = [
  [/base_url:\s*BASE\b/, 'base_url 必须指向扩展内'],
  [/skin_url:\s*BASE\s*\+\s*'\/skins\/ui\/oxide'/, 'skin_url 必须指向扩展内'],
  [/language_url:\s*BASE\s*\+/, 'language_url 必须指向扩展内'],
  [/content_css:\s*false/, 'content_css 必须是 false（否则会去拉 TinyMCE 默认皮肤 CSS）'],
  [/emoticons_images_url:\s*''/, 'emoticons_images_url 必须钉成空串（默认指向 cdnjs 的 twemoji）'],
];
for (const [re, msg] of localRules) {
  if (!re.test(inject)) fail(msg);
}
console.log('  ', localRules.length, '个资源项指向扩展包内');

// ── 7. compose 脚本装配 ──────────────────────────────────────────────────
// 这四个文件都靠 background 的 composeScripts 注入，顺序错了、少注了，
// 表现都是「某功能悄悄不生效」而编辑器一切正常 —— 没有报错、没有提示，
// 最容易在发布后才被发现。所以这里既查注册，也查顺序。
section('[7] compose 脚本装配');
const ORDER = ['compose/config.js', 'compose/i18n.js', 'compose/markdown.js', 'compose/inject.js'];
const bg = read('background.js');
const at = ORDER.map(f => bg.indexOf("'" + f + "'"));
ORDER.forEach((f, i) => { if (at[i] < 0) fail('background.js 没有注册 ' + f); });
ORDER.forEach((f, i) => {
  if (i > 0 && at[i] >= 0 && at[i - 1] >= 0 && at[i] < at[i - 1]) {
    fail(`${f} 必须排在 ${ORDER[i - 1]} 后面`);
  }
});
console.log('   注册顺序:', ORDER.join(' → '));

const deps = [
  ['compose/config.js', 'window.__tcsConfig'],
  ['compose/i18n.js', 'window.__tcsI18n'],
  ['compose/markdown.js', 'window.__tcsMarkdown'],
];
for (const [f, marker] of deps) {
  const base = f.split('/').pop();
  const own = read(f).includes('root.' + marker.split('.')[1] + ' =');
  if (!own) fail(base + ' 没有挂出 ' + marker);
  if (!inject.includes(marker)) fail('inject.js 没有取用 ' + marker);
}
if (!inject.includes("'PastePreProcess'")) fail('inject.js 没有注册 PastePreProcess');
for (const key of ['markdownPaste', 'language', 'debug']) {
  if (!new RegExp('\\b' + key + ':\\s*(true|false|.auto.)')
      .test(config)) fail('config.js 的 defaults() 里没有 ' + key + ' 默认值');
}
console.log('   markdownPaste / language / debug 默认值齐全');

// ── 8. 发布形态 ──────────────────────────────────────────────────────────
// 这几项的问题只在「上传 ATN 之后」或「用户点开选项」时才暴露：本地装 xpi
// 试不出来 —— 本地装载不看 default_locale，选项页路径写错也只是打开一片空白。
section('[8] 发布形态');
if (!mf.default_locale) {
  fail('manifest 没有 default_locale（多语言不会生效）');
} else if (!existsIn(`_locales/${mf.default_locale}/messages.json`)) {
  fail('default_locale 目录不存在: _locales/' + mf.default_locale);
}

const defaultMsgsPath = join(ROOT, '_locales', mf.default_locale || 'en', 'messages.json');
const defaultMsgs = existsSync(defaultMsgsPath)
  ? JSON.parse(readFileSync(defaultMsgsPath, 'utf8')) : {};
for (const field of ['name', 'description']) {
  const msgKey = /^__MSG_(\w+)__$/.exec(String(mf[field] || ''));
  if (!msgKey) {
    fail(`manifest.${field} 应写成 __MSG_xxx__，否则列表页只有一种语言`);
  } else if (!defaultMsgs[msgKey[1]]) {
    fail(`manifest.${field} 引用的键不在 default_locale 里: ${msgKey[1]}`);
  }
}

const optPage = mf.options_ui && mf.options_ui.page;
if (!optPage) {
  fail('manifest 没有 options_ui.page（配置只能靠控制台改）');
} else if (!existsIn(optPage)) {
  fail('options_ui 指向的页面不存在: ' + optPage);
} else {
  // 页面里引用的脚本 / 样式都必须在包里，少一个就是一张白纸
  const html = read(optPage);
  const optDir = optPage.replace(/\/[^/]+$/, '');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = resolve(ROOT, optDir, match[1]);
    if (!existsSync(target)) fail(`选项页引用了不存在的文件: ${match[1]}`);
  }
  // 三个操作 + 状态位是这一页的骨架：少一个，用户就没有「放弃改动」或
  // 「看见未保存」的入口了。
  for (const id of ['save', 'cancel', 'restore', 'status']) {
    if (!html.includes(`id="${id}"`)) fail(`选项页缺少 #${id}（保存/取消/恢复默认/状态提示）`);
  }
}

// 配置内嵌在附加组件页里：点「设置」就在当前页改完，不跳新标签页。
// 写成 true 会把整页挪走，和这一页「贴底按钮 + sticky 状态」的版式设计相反，
// 所以把结论钉在检查里，而不是靠人记得。
if (mf.options_ui && mf.options_ui.open_in_tab !== false) {
  fail('options_ui.open_in_tab 必须显式写成 false（配置要内嵌在附加组件页里）');
}

const gecko = (mf.browser_specific_settings && mf.browser_specific_settings.gecko) || {};
if (!/^[^@\s]+@[^@\s]+$/.test(String(gecko.id || ''))) {
  fail('gecko.id 不是 email 形式（ATN 要求）: ' + gecko.id);
}
if (!gecko.strict_min_version) fail('缺少 strict_min_version（ATN 会问最低版本）');
if (!(mf.web_accessible_resources || []).includes('_locales/*/messages.json')) {
  fail('web_accessible_resources 缺少 _locales/*/messages.json（撰写窗口读不到文案）');
}
console.log('   id:', gecko.id, '| options:', optPage,
            '| locales:', readdirSync(join(ROOT, '_locales')).sort().join(' '));

// ── 9. 版本号一致 ────────────────────────────────────────────────────────
// 版本号有两处是人工维护的：manifest 的 version（ATN 与 about:addons 读它），
// 以及 compose/markdown.js 的 VERSION（纯函数模块，node 里没有 browser，只能
// 写字面量）。漏改一处不报错、不影响功能，只会让 __tcsMarkdown.version 与
// 扩展版本对不上 —— 报 issue 的人拿着面板上的版本号来对源码，最难查。
section('[9] 版本号');
const mdVer = /var VERSION = '([^']+)'/.exec(read('compose/markdown.js'));
if (!mdVer) {
  fail('compose/markdown.js 里找不到 VERSION 字面量');
} else if (mdVer[1] !== mf.version) {
  fail(`版本号不一致: manifest=${mf.version}，compose/markdown.js=${mdVer[1]}`);
} else {
  console.log('   version:', mf.version, '(manifest 与 markdown.js 一致)');
}

// ── 10. 工具栏必须直角 ───────────────────────────────────────────────────
// 这条只能静态查，而且必须查「有没有 !important」，光查「写了 border-radius: 0」
// 是没有用的 —— 真机里工具栏住在 #tcs-toolbar 的 shadow root 内，shell.css 里的
// #tcs-toolbar 会被替换成 :host，特异性从 (1,1,0) 掉到 (0,2,0)；皮肤那条
//   .tox.tox-tinymce-inline .tox-editor-header
// 是 (0,3,0)，还带 overflow:hidden，于是整个工具栏被裁成一块圆角卡片。
// .harness 里复现不出来：那里是普通文档、没有 shadow，特异性正好够，一直是 PASS。
// 另外 :focus::after 的焦点环是伪元素画的，只归零主体不管用。
section('[10] 工具栏直角');
const shellCss = read('compose/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
const radiusRules = shellCss.split('}').filter(r => /border-radius\s*:/.test(r));
if (!radiusRules.length) {
  fail('shell.css 里没有任何 border-radius 规则');
}
for (const rule of radiusRules) {
  const value = /border-radius\s*:\s*([^;}]+)/.exec(rule)[1].trim();
  if (!/^0\s*!important$/.test(value)) {
    fail(`工具栏圆角必须写成 "0 !important"（shadow 里 :host 特异性不够）: ${value}`);
  }
}
const radiusText = radiusRules.join(' ');
for (const sel of ['.tox-tinymce', '.tox-editor-header', '.tox-tbtn',
                   '.tox-split-button', '::after']) {
  if (!radiusText.includes(sel)) fail(`直角规则漏了 ${sel}`);
}
console.log('   border-radius 规则:', radiusRules.length, '条，全部 0 !important');

// ── 11. TinyMCE 的版本与许可 ───────────────────────────────────────────────
// 这两条都是「出包之后才被发现」的那类问题：
//  - 装配树里的 bundle 与 package.json 声明的版本对不上（提取是上一版依赖留下的，
//    或有人手工往那里塞了别的版本）。bundle 首行注释里有
//    'TinyMCE version 7.9.3 (2026-05-19)'，就在这里读出来对账。
//  - license.md 是 GPL-2.0-or-later 要求随包分发的文本。它一度没被拷进来，
//    而 build-xpi 又会跳过所有 .md —— 两头都错，xpi 里就是没有。
section('[11] TinyMCE 版本与许可');
const tmVer = /TinyMCE version (\d+\.\d+\.\d+)/.exec(readTm('tinymce.min.js'));
const declaredTm = (JSON.parse(read('package.json')).devDependencies || {}).tinymce;
if (!tmVer) {
  fail('tinymce.min.js 首行注释里读不到版本号（换构建产物了？）');
} else if (!declaredTm) {
  fail('package.json 的 devDependencies 里没有声明 tinymce 版本');
} else if (tmVer[1] !== declaredTm) {
  fail(`装配树里的 TinyMCE 是 ${tmVer[1]}，但 package.json 声明的是 ${declaredTm}（重新 npm ci 提取）`);
} else {
  console.log('   version:', tmVer[1], '(与 package.json 一致)');
}
if (!existsSync(join(ROOT, TINYMCE_DIR, 'license.md'))) {
  fail(`${TINYMCE_DIR}/license.md 不存在（GPL 要求许可文本随包分发）`);
} else if (!/GNU General Public License/.test(readTm('license.md'))) {
  fail('license.md 内容不像 GPL 许可文本');
} else {
  // 打印包内相对路径（去掉装配树前缀），布局再动也不用改这一行
  console.log('   license:', join(TINYMCE_DIR, 'license.md').replace('dist/unpacked/', ''));
}

console.log('\n' + (ok ? '全部通过' : '有失败项'));
process.exit(ok ? 0 : 1);
