#!/usr/bin/env node
/**
 * compose/i18n.js 的断言 —— 纯 node。
 *
 * 这层代码的失败模式很安静：语言选错了就退到英文，键缺了就显示键名，
 * 界面上都「还看得过去」，但用户看到的是半英半中的界面。所以语言归一、
 * $1 替换、取不到文件时的回退链，都得有断言。
 *
 * 跑法：node tools/test-i18n.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(ROOT, 'compose/i18n.js'), 'utf8');
const sandbox = {};
new Function('window', code)(sandbox);
const I18N = sandbox.__tcsI18n;

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

console.log('\n[语言归一]');
check('auto 走系统语言', () => {
  assert.equal(I18N.resolveLocale('auto', 'zh-CN'), 'zh_CN');
  assert.equal(I18N.resolveLocale('', 'de-DE'), 'de');
  assert.equal(I18N.resolveLocale(undefined, 'ja-JP'), 'ja');
});
check('用户显式选的语言优先于系统语言', () => {
  assert.equal(I18N.resolveLocale('ja', 'en-US'), 'ja');
  assert.equal(I18N.resolveLocale('zh_TW', 'de-DE'), 'zh_TW');
});
check('中文的简繁要分清', () => {
  assert.equal(I18N.resolveLocale('auto', 'zh-CN'), 'zh_CN');
  assert.equal(I18N.resolveLocale('auto', 'zh-Hans'), 'zh_CN');
  assert.equal(I18N.resolveLocale('auto', 'zh-SG'), 'zh_CN');
  assert.equal(I18N.resolveLocale('auto', 'zh-TW'), 'zh_TW');
  assert.equal(I18N.resolveLocale('auto', 'zh-HK'), 'zh_TW');
  assert.equal(I18N.resolveLocale('auto', 'zh-Hant-TW'), 'zh_TW');
  assert.equal(I18N.resolveLocale('auto', 'zh'), 'zh_CN');
});
check('方言变体落到支持的那一档', () => {
  assert.equal(I18N.resolveLocale('auto', 'de-AT'), 'de');
  assert.equal(I18N.resolveLocale('auto', 'fr-CA'), 'fr');
  assert.equal(I18N.resolveLocale('auto', 'es-419'), 'es');
  assert.equal(I18N.resolveLocale('auto', 'ru-RU'), 'ru');
});
check('不认识的语言一律回英文（不会返回空）', () => {
  assert.equal(I18N.resolveLocale('auto', 'pt-BR'), 'en');
  assert.equal(I18N.resolveLocale('xx', 'xx-XX'), 'en');
  assert.equal(I18N.resolveLocale('auto', ''), 'en');
  assert.ok(I18N.SUPPORTED.includes(I18N.resolveLocale('auto', 'fi')));
});
check('配置里写了不合规的大小写也能认', () => {
  assert.equal(I18N.resolveLocale('ZH-cn', 'en-US'), 'zh_CN');
  assert.equal(I18N.resolveLocale('zh-tw', 'en-US'), 'zh_TW');
});

console.log('\n[$n 占位符]');
check('按位替换', () => {
  assert.equal(I18N.format('失败：$1（$2）', ['HTTP 500', 'x']), '失败：HTTP 500（x）');
});
check('缺位的原样留着，不悄悄变空', () => {
  assert.equal(I18N.format('a $1 b $2', ['X']), 'a X b $2');
});
check('没有参数时不动', () => {
  assert.equal(I18N.format('纯文本', []), '纯文本');
  assert.equal(I18N.format('纯文本'), '纯文本');
});
check('$10 只认 $1（不越界）', () => {
  assert.equal(I18N.format('$10', ['A']), 'A0');
});

console.log('\n[翻译函数]');
check('取得到就返回译文', () => {
  const t = I18N.buildT({ a: { message: '甲' }, b: { message: '乙 $1' } });
  assert.equal(t('a'), '甲');
  assert.equal(t('b', ['丙']), '乙 丙');
});
check('键缺失时返回键名（不抛错）', () => {
  const t = I18N.buildT({});
  assert.equal(t('nope'), 'nope');
});
check('空文案当缺失处理', () => {
  const t = I18N.buildT({ a: { message: '' }, b: {} });
  assert.equal(t('a'), 'a');
  assert.equal(t('b'), 'b');
});
check('旧格式（直接字符串）也认', () => {
  const t = I18N.buildT({ a: '甲' });
  assert.equal(t('a'), '甲');
});

console.log('\n[加载与回退]');
const fakeFetch = files => url => {
  const hit = files[url];
  return Promise.resolve(hit || null);
};

await (async () => {
  let seen = [];
  let out = await I18N.load('moz-extension://x/', 'zh_CN',
    url => { seen.push(url); return fakeFetch({ 'moz-extension://x/_locales/zh_CN/messages.json':
      { a: { message: '甲' } } })(url); });
  check('取到对应语言', () => {
    assert.equal(out.locale, 'zh_CN');
    assert.equal(out.t('a'), '甲');
    assert.equal(seen[0], 'moz-extension://x/_locales/zh_CN/messages.json');
  });

  seen = [];
  out = await I18N.load('moz-extension://x/', 'ja',
    url => { seen.push(url); return fakeFetch({ 'moz-extension://x/_locales/en/messages.json':
      { a: { message: 'A' } } })(url); });
  check('目标语言缺失时退到英文，并记录 fallbackFrom', () => {
    assert.equal(out.locale, 'en');
    assert.equal(out.fallbackFrom, 'ja');
    assert.equal(out.t('a'), 'A');
    assert.equal(seen.length, 2);
  });

  out = await I18N.load('moz-extension://x/', 'de', () => Promise.resolve(null));
  check('全都没有时标记 missing，键名照常返回（编辑器不因此罢工）', () => {
    assert.equal(out.missing, true);
    assert.equal(out.locale, 'en');
    assert.equal(out.t('a'), 'a');
  });

  seen = [];
  await I18N.load('moz-extension://x', 'en', url => { seen.push(url); return Promise.resolve(null); });
  check('base 末尾少了斜杠也能拼对', () => {
    assert.equal(seen[0], 'moz-extension://x/_locales/en/messages.json');
  });

  out = await I18N.load('moz-extension://x/', 'auto',
    (url) => Promise.resolve(url.includes('/zh_CN/') ? { a: { message: '甲' } } : null));
  check('auto 在没有任何系统语言信息时落英文', () => {
    assert.equal(out.locale, 'en');
  });
})();

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) process.exit(1);
