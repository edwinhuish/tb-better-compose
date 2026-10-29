#!/usr/bin/env node
/**
 * 一个操作：打印 TinyMCE 的提取清单（包内路径 ← node_modules 来源）。
 *
 * 它不是「另一份清单」，只是 extract-tinymce.mjs 里那份清单的只读视图：清单内容
 * 与解析规则都只有一处，这里只负责排版。所以这个文件不导出任何东西，也不写磁盘。
 *
 * 什么时候用：确认「这个文件到底该不该在包里」「某个插件来自哪个包」，或者怀疑
 * 提取漏了东西时对着它数。它只读 compose/inject.js 与清单本身，不读 vendor/，
 * 所以 vendor 是空的也能跑。
 *
 * 加插件/加语言不在这里改 —— 白名单的唯一来源是 compose/inject.js。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tinymceFiles, TINYMCE_DIR } from './extract-tinymce.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.log('用法: node tools/list-tinymce-files.mjs\n\n打印提取清单：包内路径 ← node_modules 里的来源。');
  process.exit(0);
}

const files = tinymceFiles(root);
if (!files.length) {
  console.error('[tinymce] 清单为空：compose/inject.js 里的 plugins / TM_LANG 没解析出来');
  process.exit(1);
}

const width = Math.max(...files.map(f => f.rel.length));
for (const f of files) {
  console.log(`  ${f.rel.padEnd(width)}  ←  ${f.src}`);
}
console.log(`\n共 ${files.length} 个文件 → ${TINYMCE_DIR}/`);
