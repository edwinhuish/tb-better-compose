#!/usr/bin/env node
/**
 * 一个操作：把 TinyMCE 按清单从 node_modules 提取到 vendor/tinymce/。
 *
 * 同时是这份清单的**定义处**（CORE / PLUGIN_EXTRA / 语言包位置 / 路径常量），
 * 所以 check-static、check-i18n、build-xpi 都从这里 import —— 它们要判断的正是
 * 「提取的结果对不对」「提取跑过没有」，依赖提取器本身是合理的。
 * 只读的清单查看器在 tools/list-tinymce-files.mjs，它 import 这里，不反向依赖。
 *
 * 默认动作就是唯一的动作：npm postinstall 里直接 `node tools/extract-tinymce.mjs`。
 * 单操作的文件不需要子命令分发 —— 想改「提取什么」请改 compose/inject.js。
 *
 * ── 为什么必须裁剪 ──────────────────────────────────────────────────────
 *
 * 这是整条构建/打包链里**唯一一次拷贝**。项目根就是包根（manifest.json、
 * compose/、options/、icons/、_locales/ 都在根上），没有中间装配树：打包脚本按
 * 顶层项白名单直接读这些目录和 vendor/。
 *
 * vendor/ 必须落在包里，而 npm 发行包里的 tinymce/ 有 22 个插件、全部语言、
 * 用不到的皮肤，直接入包会白白多出十几 MB。包内路径又与运行时约定死：
 * compose/inject.js 的 base_url / skin_url / language_url 全从
 * runtime.getURL('vendor/tinymce') 派生，TinyMCE 自己再按 `suffix: '.min'` 拼出
 * skins/ui/oxide/skin.min.css。
 *
 * 层级尽量贴着上游：CORE 里的路径与 node_modules/tinymce 完全同名，插件保持
 * plugins/<name>/… 原样。所以「少打包了什么」可以直接对着上游目录比出来
 * （`node tools/list-tinymce-files.mjs` 打的就是这张对照表）。
 *
 * ── 为什么不删 node_modules ─────────────────────────────────────────────
 *
 * 以前把它当「一次性中转站」，提取完就删，好处是构建链绝不会去读它；代价是每次
 * 改 inject.js 的插件列表都要重装依赖才能重新提取，也没法复查「到底取了哪几个
 * 文件」。现在 node_modules 保留（本来就在 .gitignore 里），提取只由本文件做、
 * 每次整棵重建 vendor/tinymce，不存在「两份可能被读的源」；版本错位由
 * check-static 第 11 节对账（vendor 里 bundle 的版本号 vs package.json）。
 *
 * 失败策略：提取失败 → 退出码 1（此时 vendor 是坏的或空的，不能装作装好了）。
 */

import { readFileSync, copyFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 第三方静态资源的落脚点：仓库根（也就是包根）下的 `vendor/`。
 *
 * 单独一层是为了让根目录分出两类东西：我们写的（manifest.json、compose/、options/、
 * icons/、_locales/）与上游来的（vendor/tinymce/）。前者进版本库，后者是生成物。
 */
export const VENDOR_DIR = 'vendor';

/** TinyMCE 在 vendor/ 下的子目录名，也就是运行期 base_url 指向的那一层。 */
export const TINYMCE_SUBDIR = 'tinymce';

/**
 * TinyMCE 在仓库里的完整位置（= 包内 `vendor/tinymce/…`）。
 *
 * 所有工具都基于这个常量拼子路径（tinymce.min.js、plugins/、langs/…），所以布局
 * 再动一次时只改上面两个常量就够了。
 */
export const TINYMCE_DIR = `${VENDOR_DIR}/${TINYMCE_SUBDIR}`;

/** 上游依赖在仓库里的位置。node_modules 会保留，postinstall 之后仍可复查。 */
const TINYMCE_PKG = 'node_modules/tinymce';
const TINYMCE_I18N_PKG = 'node_modules/tinymce-i18n';

/**
 * 核心文件：TinyMCE 初始化时一定会读的那几个，加上许可文本。
 *
 * skins 里带 content 的三份目前是用不到的（init 里 content_css: false，样式由
 * content_style 提供），先留着 —— 裁剪另开一次提交、配真机回归再删。
 */
const CORE = [
  'tinymce.min.js',
  'themes/silver/theme.min.js',
  'models/dom/model.min.js',
  'icons/default/icons.min.js',
  'skins/ui/oxide/skin.min.css',
  'skins/ui/oxide/content.min.css',
  'skins/ui/oxide/content.inline.min.css',
  'skins/content/default/content.min.css',
  'license.md',                       // GPL-2.0-or-later 要求随包分发
];

/**
 * 插件除 plugin.min.js 之外还必须一起带走的附属文件（相对 plugins/<name>/）。
 * 表情面板里那几百个字符全在 emojis.min.js 里，漏了就是空白面板。
 */
const PLUGIN_EXTRA = {
  emoticons: ['js/emojis.min.js'],
};

/** 语言包在包内的位置（也就是 vendor/tinymce/langs/）。 */
const LANG_DIR = 'langs';
/** 语言包在 tinymce-i18n 里的位置：langs7 才是给 TinyMCE 7 用的。 */
const I18N_LANG_DIR = 'langs7';

/**
 * 从 compose/inject.js 解析出的两份白名单。
 *
 * 放在这里而不是让每个工具各写一份正则：plugins 列表与 TM_LANG 映射是唯一的
 * 事实源，解析规则只该有一处 —— 否则提取认一套、校验认另一套，写漏的那份永远
 * 是「不报错但少文件」的那一半。
 *
 * @returns {{ plugins: string[], langMap: Record<string, string> | null }}
 *   langMap 为 null 表示 inject.js 里找不到 TM_LANG 映射表（由调用方决定怎么报）。
 */
export function readWhitelist(root) {
  const inject = readFileSync(join(root, 'compose/inject.js'), 'utf8');

  const plugins = (/plugins:\s*([\s\S]*?),\n\n/.exec(inject)?.[1] || '')
    .replace(/['"+\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // tcs_fp 是自己注册的工具栏按钮，不是 TinyMCE 插件，没有对应目录
    .filter(p => p !== 'tcs_fp');

  const mapSrc = /const TM_LANG = \{([\s\S]*?)\};/.exec(inject)?.[1];
  const langMap = mapSrc === undefined
    ? null
    : Object.fromEntries(
        [...mapSrc.matchAll(/([A-Za-z_]+)\s*:\s*'([^']*)'/g)].map(m => [m[1], m[2]])
      );

  return { plugins, langMap };
}

/**
 * 提取清单：`{ rel: 'plugins/lists/plugin.min.js', src: 'node_modules/…' }`。
 *
 * rel 相对 TINYMCE_DIR（也就是包内 vendor/tinymce/ 下面的路径）；src 是磁盘上的来源。
 * 两者只有语言包不同名（langs/<code>.js ← tinymce-i18n/langs7/<code>.js）。
 * 顺序稳定（核心 → 插件 → 语言包），保证产物可复现。
 */
export function tinymceFiles(root) {
  const { plugins, langMap } = readWhitelist(root);
  const files = [];

  const add = (rel, src) => files.push({ rel, src });

  for (const rel of CORE) add(rel, `${TINYMCE_PKG}/${rel}`);

  for (const p of plugins) {
    add(`plugins/${p}/plugin.min.js`, `${TINYMCE_PKG}/plugins/${p}/plugin.min.js`);
    for (const extra of PLUGIN_EXTRA[p] ?? []) {
      add(`plugins/${p}/${extra}`, `${TINYMCE_PKG}/plugins/${p}/${extra}`);
    }
  }

  for (const code of Object.values(langMap ?? {}).filter(Boolean)) {
    add(`${LANG_DIR}/${code}.js`, `${TINYMCE_I18N_PKG}/${I18N_LANG_DIR}/${code}.js`);
  }

  return files;
}

/**
 * 校验/打包前调用：vendor 里没有 TinyMCE 就说明白下一步敲什么，而不是抛 ENOENT。
 *
 * vendor/ 是生成物且被 gitignore，克隆下来第一次必须先装依赖；之后它一直在，
 * 只有手工 `rm -rf vendor` 才会再缺。
 */
export function ensureTinymce(root) {
  if (existsSync(join(root, TINYMCE_DIR, 'tinymce.min.js'))) return;
  console.error(`\n找不到 ${TINYMCE_DIR}/tinymce.min.js —— 它是 npm 的 postinstall 生成的：`);
  console.error('  npm install   # 或 npm ci：装依赖 → 按白名单提取到 vendor/tinymce');
  console.error('  （vendor/ 是生成物、不在版本库里，所以 `rm -rf vendor` 后要重装一次）\n');
  process.exit(1);
}

/**
 * 按清单重建 vendor/tinymce。
 *
 * 先整棵删再逐个拷：「删掉一个插件」才能真的从包里消失，而不是留下上次的残骸。
 * 只动 vendor/tinymce，根目录下别的文件一律不碰。
 *
 * @returns {{ skipped?: string, count?: number, bytes?: number,
 *             plugins?: string[], langs?: string[],
 *             versions?: { tinymce: string, i18n: string } }}
 */
export function extract(root) {
  const nodeModules = join(root, 'node_modules');

  // postinstall 也可能在「只重装某个包」时被触发。依赖没在本地就不必提取
  // （vendor 里已有的那份仍然可用）—— 这时安静退出，别把安装流程搅黄。
  if (!existsSync(nodeModules)) {
    return { skipped: 'no-node-modules' };
  }

  const files = tinymceFiles(root);
  if (!files.length) {
    throw new Error('清单为空：compose/inject.js 里的 plugins / TM_LANG 没解析出来');
  }

  const out = join(root, TINYMCE_DIR);
  rmSync(out, { recursive: true, force: true });

  let bytes = 0;
  for (const f of files) {
    const src = join(root, f.src);
    let st;
    try {
      st = statSync(src);
    } catch {
      throw new Error(
        `缺少 ${f.src}\n  上游换布局了，或 compose/inject.js 里写了上游不存在的插件 / 语言`
      );
    }
    const dest = join(out, f.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    bytes += st.size;
  }

  const readVer = pkg =>
    JSON.parse(readFileSync(join(nodeModules, pkg, 'package.json'), 'utf8')).version;
  const { plugins, langMap } = readWhitelist(root);

  return {
    count: files.length,
    bytes,
    plugins,
    langs: Object.values(langMap ?? {}).filter(Boolean),
    versions: { tinymce: readVer('tinymce'), i18n: readVer('tinymce-i18n') },
  };
}

// ── 命令行 ──────────────────────────────────────────────────────────────
// 只有被 node 直接执行时才跑；被 import 时这一段整体不生效。

const USAGE = `用法: node tools/extract-tinymce.mjs

按 compose/inject.js 的 plugins / TM_LANG 白名单，从 node_modules 提取到
${TINYMCE_DIR}/，然后打印体积与版本。要看清单本身：
  node tools/list-tinymce-files.mjs`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    const r = extract(root);
    if (r.skipped) {
      console.log('[tinymce] 没有 node_modules，跳过提取（vendor/ 里已有的那份仍然可用）');
    } else {
      const note = msg => console.log(`[tinymce] ${msg}`);
      note(`${TINYMCE_DIR}: ${r.count} 个文件, ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
      note(`  tinymce@${r.versions.tinymce}  tinymce-i18n@${r.versions.i18n}`);
      note(`  ${r.plugins.length} 个插件, ${r.langs.length} 个语言包: ${r.langs.join(' ')}`);
      note('  打包时只读这里，构建不再回头读 node_modules');
    }
  } catch (e) {
    console.error(`[tinymce] ${e.message}`);
    process.exit(1);
  }
}
