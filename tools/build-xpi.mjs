#!/usr/bin/env node
/**
 * 打 .xpi：把「包内该有的那几项」直接从项目根压成 zip。
 *
 * 没有中间装配树。项目根就是包根 —— manifest.json、background.js、compose/、
 * options/、icons/、_locales/ 就摆在根上，vendor/ 由 postinstall 铺好，所以打包
 * 不需要任何拷贝或路径映射，只做两件事：按白名单挑顶层项、压 zip。
 *
 * 代价是「哪些进包」这件事现在**只有一个地方**说（下面的 PACKAGE_ENTRIES），
 * 而根目录同时住着 tools/、node_modules/、dist/、文档这些不进包的东西。所以
 * 白名单写成显式清单而不是「排除法」：漏加一项的后果是包里缺文件（check-static
 * 会先一步报出来），而排除法写错的后果是把 node_modules 打进包里。
 *
 * 手写 zip 而不是用现成库：xpi 就是 zip，但仓库里不想为了打包多装一个依赖
 * （archiver / jszip），也不想依赖系统的 zip 命令（Windows 上名字还不一样）。
 * deflate 用 zlib，头信息按 PKZIP APPNOTE 手写。
 *
 * 时间戳固定成 2020-01-01 12:00：内容不变则产物字节不变（可复现构建），
 * 报「这个 xpi 什么时候打的」时看内部文件的 mtime 也没有意义。
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureTinymce } from './extract-tinymce.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 进包的顶层项。**白名单，不是排除法**：根目录里还有 tools/、node_modules/、
 * dist/、README 等不进包的东西，靠排除迟早漏掉一个。
 *
 * vendor/ 整棵进包（下面就是 TinyMCE），保持与运行期 base_url 一致的层级。
 */
const PACKAGE_ENTRIES = [
  'manifest.json',
  'background.js',
  'compose',
  'options',
  'icons',
  '_locales',
  'vendor',
];

/** 万一白名单被改错，这几项绝不允许出现在包里。 */
const NEVER = ['node_modules', 'dist', 'tools', '.git'];

ensureTinymce(ROOT);

if (!existsSync(join(ROOT, 'manifest.json'))) {
  console.error('\n根目录没有 manifest.json —— 它应该就在项目根（包根）：');
  console.error('  手写源码（manifest / background / compose / options / icons / _locales）都在根上\n');
  process.exit(1);
}

const missing = PACKAGE_ENTRIES.filter(e => !existsSync(join(ROOT, e)));
if (missing.length) {
  console.error('\n包内白名单里有不存在的东西：\n' + missing.map(e => '  ' + e).join('\n'));
  console.error('  vendor/ 是 postinstall 生成的：npm install\n');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const out = process.argv[2] || `dist/better-compose-${manifest.version}.xpi`;
const outPath = resolve(ROOT, out);

// ── CRC32 ────────────────────────────────────────────────────────────────
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 收集文件 ─────────────────────────────────────────────────────────────
// 包内路径 = 相对项目根的路径（正斜杠）。只在白名单给出的顶层项里走，别的目录
// 连读都不读 —— 不存在「顺手把 node_modules 打包进去」这种可能。
function collect(rel, out) {
  const abs = join(ROOT, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) collect(`${rel}/${name}`, out);
  } else {
    out.push(rel);
  }
  return out;
}

const files = [];
for (const entry of PACKAGE_ENTRIES) collect(entry, files);

const leaked = files.filter(f => NEVER.some(n => f === n || f.startsWith(n + '/')));
if (leaked.length) {
  console.error('\n以下路径不该进包（白名单写错了？）：\n' + leaked.slice(0, 10).map(f => '  ' + f).join('\n'));
  process.exit(1);
}

// ── DOS 时间（固定值，保证可复现）───────────────────────────────────────
const DOS_TIME = (12 << 11) | (0 << 5) | (0 << 1);        // 12:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;     // 2020-01-01

function localHeader(nameBuf, crc, csize, usize) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);          // version needed
  h.writeUInt16LE(0x0800, 6);      // flag: 文件名 UTF-8
  h.writeUInt16LE(8, 8);           // method: deflate
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(csize, 18);
  h.writeUInt32LE(usize, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);          // extra len
  return Buffer.concat([h, nameBuf]);
}

function centralHeader(nameBuf, crc, csize, usize, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);          // version made by
  h.writeUInt16LE(20, 6);          // version needed
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(csize, 20);
  h.writeUInt32LE(usize, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(0, 30);          // extra
  h.writeUInt16LE(0, 32);          // comment
  h.writeUInt16LE(0, 34);          // disk
  h.writeUInt16LE(0, 36);          // internal attrs
  h.writeUInt32LE(0, 38);          // external attrs
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, nameBuf]);
}

// ── 主流程 ───────────────────────────────────────────────────────────────
mkdirSync(dirname(outPath), { recursive: true });

const locals = [];
const centrals = [];
let offset = 0;

for (const rel of files) {
  const raw = readFileSync(join(ROOT, rel));
  const packed = deflateRawSync(raw, { level: 9 });
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(raw);

  const lh = localHeader(name, crc, packed.length, raw.length);
  locals.push(lh, packed);
  centrals.push(centralHeader(name, crc, packed.length, raw.length, offset));
  offset += lh.length + packed.length;
}

const cd = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, cd, eocd]);
writeFileSync(outPath, zip);

const kb = (zip.length / 1024).toFixed(0);
console.log(`written ${out}  (${files.length} entries, ${kb} KB, version ${manifest.version})`);

// 最后让独立实现复核一遍：zip 头信息是我们自己按 APPNOTE 手写的，
// 自己算的 CRC 校验不出自己写错的头。没装 unzip 就跳过 —— 不把校验变成依赖。
const unzip = spawnSync('unzip', ['-t', outPath], { encoding: 'utf8' });
if (unzip.error) {
  console.log('  (跳过 zip 复核：这台机器没有 unzip)');
} else if (unzip.status !== 0) {
  console.error('zip 复核失败：\n' + (unzip.stdout || '') + (unzip.stderr || ''));
  process.exit(1);
} else {
  console.log('  zip ok: ' + basename(outPath));
}
