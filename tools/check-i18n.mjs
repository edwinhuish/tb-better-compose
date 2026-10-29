#!/usr/bin/env node
/**
 * 多语言一致性校验。
 *
 * 这类错误的特点：**不报错、不崩溃**，只是界面上少一个词或者显示成
 * `opt_toolbar_add` 这种键名。等用户截图来问的时候，已经不知道是哪一次改动
 * 漏了。所以这里把能静态查的全查掉：
 *
 *  1. 八个 _locales/&lt;code&gt;/messages.json 的键集合必须与英文完全一致
 *  2. 一条文案不能是空的；$1…$9 占位符必须与英文一致（否则译文会丢掉参数，
 *     或者多出一个永远不会被替换的 $2）
 *  3. 键名只能是 [a-z0-9_]（WebExtension 对 __MSG___ 替换有字符限制，
 *     顺便也是这份文件还能被 browser.i18n 直接用的前提）
 *  4. 代码里 t('...') 用到的键、选项页 data-i18n="..." 用到的键、
 *     config.js 里按钮分组用到的键，都必须在英文表里存在
 *  5. LANGUAGES（config.js）/ SUPPORTED（i18n.js）/ _locales 目录 /
 *     TinyMCE 的 TM_LANG 映射与 lang 文件，四处必须对得上
 *
 * 反过来，英文表里存在但代码没用到的键只提示、不判失败 —— 加语言时先写好
 * 文案再接代码是正常顺序。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TINYMCE_DIR, ensureTinymce } from './extract-tinymce.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
ensureTinymce(ROOT);
let ok = true;

const fail = msg => { ok = false; console.log('  FAIL', msg); };
const warn = msg => console.log('  warn', msg);
const section = t => console.log('\n' + t);
const read = p => readFileSync(join(ROOT, p), 'utf8');
const loadJson = p => JSON.parse(read(p));

// 把一个「挂 window.xxx」的脚本装进假 window，拿到它导出的对象。
// compose/config.js 与 compose/i18n.js 都刻意不碰 DOM，所以能这么测。
function sandbox(file) {
  const box = {};
  new Function('window', read(file))(box);
  return box;
}

const LOCALE_DIR = join(ROOT, '_locales');
const locales = readdirSync(LOCALE_DIR)
  .filter(name => statSync(join(LOCALE_DIR, name)).isDirectory())
  .sort();

// ── 1. 键集合与占位符 ────────────────────────────────────────────────────
section('[1] 各语言键集合');
const en = loadJson('_locales/en/messages.json');
const enKeys = Object.keys(en).sort();
console.log('   en 有', enKeys.length, '条；语言目录:', locales.join(' '));

const PLACEHOLDER = /\$\d/g;
for (const locale of locales) {
  const msgs = loadJson(`_locales/${locale}/messages.json`);
  const keys = Object.keys(msgs);

  const missing = enKeys.filter(k => !(k in msgs));
  const extra = keys.filter(k => !(k in en));
  if (missing.length) fail(`${locale} 缺 ${missing.length} 条: ${missing.join(', ')}`);
  if (extra.length) fail(`${locale} 多出英文里没有的键: ${extra.join(', ')}`);

  for (const key of keys) {
    const entry = msgs[key];
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      fail(`${locale}/${key} 是空的`);
      continue;
    }
    if (!/^[a-z0-9_]+$/.test(key)) fail(`${locale} 的键名不合规: ${key}`);
    const want = (en[key] ? en[key].message.match(PLACEHOLDER) || [] : []).join(',');
    const got = (entry.message.match(PLACEHOLDER) || []).join(',');
    if (want !== got) {
      fail(`${locale}/${key} 占位符不一致：英文 [${want}]，本地 [${got}]`);
    }
  }
}

// ── 2. 代码里用到的键 ────────────────────────────────────────────────────
section('[2] 代码引用的键');
const CODE_FILES = [
  'compose/config.js', 'compose/i18n.js', 'compose/inject.js',
  'compose/markdown.js', 'options/options.js',
];
const used = new Set();

for (const file of CODE_FILES) {
  const src = read(file);
  // t('key') / tr('key') —— config.js 的 defaults() 里参数叫 tr（t 是形参名）。
  // 只认字面量；动态键靠下面 config.js 与色板表的展开来兜。
  for (const m of src.matchAll(/\b(?:t|tr)\(\s*'([A-Za-z0-9_]+)'/g)) {
    used.add(m[1]);
    if (!(m[1] in en)) fail(`${file} 用了不存在的键: ${m[1]}`);
  }
  // 色板这类「键 + 十六进制」的成对数据表：键不是 t() 调用的实参，
  // 但 COLORS 那一步会 map 出来翻译，所以按形状认。
  for (const m of src.matchAll(/\['([a-z0-9_]+)',\s*'[0-9A-Fa-f]{6}'\]/g)) {
    used.add(m[1]);
    if (!(m[1] in en)) fail(`${file} 的色板表里用了不存在的键: ${m[1]}`);
  }
}

// data-i18n="key"（选项页的静态文案）
const html = read('options/options.html');
for (const m of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) {
  used.add(m[1]);
  if (!(m[1] in en)) fail(`options.html 用了不存在的键: ${m[1]}`);
}

// config.js 里按钮分组的文案键是数据，不是 t() 调用 —— 把文件装进假 window
// 直接读出来，比正则靠谱（分组结构改过一次，正则当时就抓漏了）。
const CC = sandbox('compose/config.js').__tcsConfig;
if (!CC) {
  fail('compose/config.js 没有导出 __tcsConfig');
} else {
  for (const group of CC.BUTTON_GROUPS) {
    for (const key of [group.title]) {
      used.add(key);
      if (!(key in en)) fail('BUTTON_GROUPS 的分组名缺文案: ' + key);
    }
    for (const [token, key] of group.items) {
      used.add(key);
      if (!(key in en)) fail(`BUTTON_GROUPS 里 ${token} 缺文案: ${key}`);
      if (!CC.KNOWN_BUTTONS.has(token)) {
        fail(`BUTTON_GROUPS 里的 ${token} 不在 KNOWN_BUTTONS 里（加了也白加）`);
      }
    }
  }
}
console.log('   代码与页面共引用', used.size, '条');

// ── 3. 语言清单四处对齐 ──────────────────────────────────────────────────
section('[3] 语言清单');
const I18N = sandbox('compose/i18n.js').__tcsI18n;
if (!I18N) {
  fail('compose/i18n.js 没有导出 __tcsI18n');
} else {
  const supported = [...I18N.SUPPORTED].sort();
  if (supported.join() !== locales.join()) {
    fail(`i18n.SUPPORTED [${supported.join(' ')}] 与 _locales 目录 [${locales.join(' ')}] 不一致`);
  }
  const langs = CC ? CC.LANGUAGES.filter(c => c !== 'auto').sort() : [];
  if (langs.join() !== supported.join()) {
    fail(`config.LANGUAGES [${langs.join(' ')}] 与 i18n.SUPPORTED [${supported.join(' ')}] 不一致`);
  }
  if (!CC || !CC.LANGUAGES.includes('auto')) fail('config.LANGUAGES 里缺 auto');
  if (I18N.FALLBACK !== 'en') fail('i18n 的 FALLBACK 不是 en（英文表是母版）');
  console.log('   ', locales.length, '种语言:', locales.join(' '));
}

// ── 4. TinyMCE 语言文件 ──────────────────────────────────────────────────
// TinyMCE 的语言代码与 _locales 目录名并不总是一致（法语是 fr_FR），
// 所以 inject.js 里有一张映射表。它写错的表现是「编辑器界面还是英文」，
// 不报错，只能靠查。
section('[4] TinyMCE 语言文件');
const inject = read('compose/inject.js');
const mapMatch = inject.match(/const TM_LANG = \{([\s\S]*?)\};/);
if (!mapMatch) {
  fail('inject.js 里找不到 TM_LANG 映射表');
} else {
  const map = {};
  for (const m of mapMatch[1].matchAll(/([A-Za-z_]+)\s*:\s*'([^']*)'/g)) map[m[1]] = m[2];
  for (const locale of locales) {
    if (!(locale in map)) { fail(`TM_LANG 缺 ${locale}（编辑器界面会掉回英文）`); continue; }
    const code = map[locale];
    if (!code) {
      if (locale !== 'en') fail(`TM_LANG 里 ${locale} 是空串，但它不是英文`);
      continue;
    }
    if (!existsSync(join(ROOT, TINYMCE_DIR, 'langs', code + '.js'))) {
      fail(`vendor/tinymce/langs/${code}.js 不存在（${locale} 需要它；改过 TM_LANG 之后重新 npm ci）`);
    }
  }
  console.log('   映射:', Object.entries(map).map(([k, v]) => k + '→' + (v || '内置')).join(' '));
}

// ── 5. manifest 的 __MSG__ ──────────────────────────────────────────────
section('[5] manifest 文案键');
const mf = loadJson('manifest.json');
for (const field of ['name', 'description']) {
  const m = /^__MSG_(\w+)__$/.exec(String(mf[field] || ''));
  if (!m) fail(`manifest.${field} 不是 __MSG_ 形式`);
  else if (!(m[1] in en)) fail(`manifest.${field} 引用的键不在英文表里: ${m[1]}`);
  else used.add(m[1]);
}

// 未引用统计放在最后：前面几步会往 used 里补（manifest、色板表）
const unused = enKeys.filter(k => !used.has(k));
if (unused.length) {
  warn('英文表里未被引用: ' + unused.join(', '));
} else {
  console.log('   没有多余文案');
}

console.log('\n' + (ok ? '全部通过' : '有失败项'));
process.exit(ok ? 0 : 1);
