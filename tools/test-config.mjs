#!/usr/bin/env node
/**
 * compose/config.js 的断言 —— 纯 node。
 *
 * 这个文件是「配置的唯一来源」：撰写窗口与选项页都读它。它一旦算错，
 * 表现是工具栏少按钮、块格式丢项、或者用户在选项页存的配置在编辑器里不认账，
 * 而这些都不会报错。所以默认值、白名单、回退逻辑都得有断言钉住。
 *
 * 跑法：node tools/test-config.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(ROOT, 'compose/config.js'), 'utf8');
const sandbox = {};
new Function('window', code)(sandbox);
const CC = sandbox.__tcsConfig;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name);
    console.log('       ' + String(e.message).split('\n').slice(0, 6).join('\n       '));
  }
}

// 假的翻译函数：模拟中文界面，同时能验出「默认值确实过了 t()」
const zh = {
  block_body: '正文文本', block_paragraph: '段落',
  block_heading: '标题 $1', block_pre: '预格式化',
};
const t = (key, subs) => {
  const raw = zh[key];
  if (!raw) return key;
  return subs && subs.length ? raw.replace(/\$(\d)/g, (m, d) => subs[Number(d) - 1] ?? m) : raw;
};
const en = key => key;

console.log('\n[默认值]');
check('默认块格式的第一项是「正文文本=div」', () => {
  assert.equal(CC.defaults(t).blockFormats.split(';')[0], '正文文本=div');
});
check('标题的序号进了名字（标题 1=h1 … 标题 6=h6）', () => {
  const list = CC.defaults(t).blockFormats.split(';');
  assert.ok(list.includes('标题 1=h1'));
  assert.ok(list.includes('标题 6=h6'));
});
check('默认值随语言变（英文下不是中文名）', () => {
  const list = CC.defaults(en).blockFormats;
  assert.ok(list.startsWith('block_body=div'), list);
});
check('没传翻译函数也不炸（退回键名）', () => {
  const list = CC.defaults().blockFormats;
  assert.ok(list.includes('block_body=div'));
});
check('默认工具栏是 18 个按钮', () => {
  const tokens = CC.defaults(t).toolbar.split(/\s+/).filter(x => x && x !== '|');
  assert.equal(tokens.length, 18);
});
check('默认值与 TOOLBAR_DEFAULT 一致', () => {
  assert.equal(CC.defaults(t).toolbar, CC.TOOLBAR_DEFAULT);
});

console.log('\n[块格式解析]');
check('字符串形式', () => {
  assert.deepEqual(CC.parseBlockFormats('正文=div;段落=p', t),
    [['正文', 'div'], ['段落', 'p']]);
});
check('数组形式', () => {
  assert.deepEqual(CC.parseBlockFormats([['标题', 'h1'], ['a', 'p']], t),
    [['标题', 'h1'], ['a', 'p']]);
});
check('标签大小写归一 + 前后空格', () => {
  assert.deepEqual(CC.parseBlockFormats('  大标题 = H2 ', t), [['大标题', 'h2']]);
});
check('非法标签被丢掉，其余保留', () => {
  assert.deepEqual(CC.parseBlockFormats('好=div;坏=script', t), [['好', 'div']]);
});
check('全非法时回退默认（不会没有块格式）', () => {
  assert.equal(CC.parseBlockFormats('坏=script;也坏=sect', t).length, 9);
});
check('空值回退默认', () => {
  assert.equal(CC.parseBlockFormats('', t).length, 9);
  assert.equal(CC.parseBlockFormats(undefined, t).length, 9);
});

console.log('\n[工具栏清理]');
check('竖线去重、去首尾', () => {
  assert.deepEqual(CC.normalizeToolbar('| undo | | redo |'), ['undo', '|', 'redo']);
});
check('粘在一起的 || 当未知 token 丢掉（我们自己拼的串总是带空格）', () => {
  assert.deepEqual(CC.normalizeToolbar('undo || redo'), ['undo', 'redo']);
});
check('未知按钮被丢弃', () => {
  assert.deepEqual(CC.normalizeToolbar('undo nope redo'), ['undo', 'redo']);
});
check('一个都不剩时回退默认', () => {
  assert.deepEqual(CC.normalizeToolbar('nope nope2'),
    CC.TOOLBAR_DEFAULT.split(/\s+/).filter(x => x && x !== '|'));
});
check('数组形式也能吃', () => {
  assert.deepEqual(CC.normalizeToolbar(['undo', '|', 'redo']), ['undo', '|', 'redo']);
});

console.log('\n[布尔与语言]');
check('asBool 认得常见写法', () => {
  assert.equal(CC.asBool('true'), true);
  assert.equal(CC.asBool(1), true);
  assert.equal(CC.asBool('on'), true);
  assert.equal(CC.asBool('false'), false);
  assert.equal(CC.asBool(0), false);
  assert.equal(CC.asBool('off'), false);
});
check('asBool 认不出来时用默认值', () => {
  assert.equal(CC.asBool('maybe', true), true);
  assert.equal(CC.asBool(undefined, false), false);
  assert.equal(CC.asBool('', true), true);
});
check('语言别名归一', () => {
  assert.equal(CC.normalizeLanguage('zh-CN'), 'zh_CN');
  assert.equal(CC.normalizeLanguage('zh_TW'), 'zh_TW');
  assert.equal(CC.normalizeLanguage('ja'), 'ja');
});
check('不认识的语言回 auto', () => {
  assert.equal(CC.normalizeLanguage('xx'), 'auto');
  assert.equal(CC.normalizeLanguage(''), 'auto');
  assert.equal(CC.normalizeLanguage(undefined), 'auto');
});

console.log('\n[整体规范化]');
check('空配置 = 默认值', () => {
  const cfg = CC.normalize(null, t);
  assert.equal(cfg.defaultBlockFormat, 'div');
  assert.equal(cfg.markdownPaste, true);
  assert.equal(cfg.language, 'auto');
  assert.equal(cfg.debug, false);
  assert.equal(cfg.blockFormats.length, 9);
});
check('默认块不在清单里时回退 div', () => {
  const cfg = CC.normalize({ blockFormats: 'A=h1', defaultBlockFormat: 'h3' }, t);
  assert.equal(cfg.defaultBlockFormat, 'h1');   // 清单里没 div，退到第一项
});
check('清单里有 div 时优先回退 div', () => {
  const cfg = CC.normalize({ blockFormats: 'A=h1;B=div', defaultBlockFormat: 'p' }, t);
  assert.equal(cfg.defaultBlockFormat, 'div');
});
check('storage 里的 "false" 字符串也当关', () => {
  assert.equal(CC.normalize({ markdownPaste: 'false' }, t).markdownPaste, false);
  assert.equal(CC.normalize({ debug: 'true' }, t).debug, true);
});
check('脏配置不会让 normalize 抛错', () => {
  const cfg = CC.normalize({ toolbar: 42, blockFormats: {}, language: [] }, t);
  assert.equal(cfg.toolbar.length > 0, true);
  assert.equal(cfg.language, 'auto');
});

console.log('\n[与默认值求差]');
check('没改过 → 空对象（storage 里等于清空覆盖）', () => {
  assert.deepEqual(CC.diff(CC.normalize(null, t), t), {});
});
check('只写改过的键', () => {
  const cfg = CC.normalize({ toolbar: 'undo redo' }, t);
  assert.deepEqual(CC.diff(cfg, t), { toolbar: 'undo redo' });
});
check('默认块名（翻译过的）不算改动', () => {
  const cfg = CC.normalize({ blockFormats: CC.defaults(t).blockFormats }, t);
  assert.deepEqual(CC.diff(cfg, t), {});
});
check('自己写的块名算改动', () => {
  const cfg = CC.normalize({ blockFormats: '正文=div;代码=pre' }, t);
  assert.deepEqual(CC.diff(cfg, t), { blockFormats: '正文=div;代码=pre' });
});
check('换了语言之后，同一份中文默认名会被当成「自定义」', () => {
  // 这正是选项页在切换语言时要重置「没动过」的块格式的原因：
  // diff 是拿**当前语言的默认值**比的，中文名对英文默认值当然不等。
  const zhCfg = CC.normalize(null, t);
  assert.ok(CC.diff(zhCfg, en).blockFormats, '中文默认名应当被判为自定义');
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) process.exit(1);
