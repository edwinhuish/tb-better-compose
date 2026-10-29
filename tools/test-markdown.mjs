#!/usr/bin/env node
/**
 * compose/markdown.js 的断言 —— 纯 node，不开浏览器。
 *
 * markdown.js 是 IIFE 挂 window.__tcsMarkdown，没有 ESM 导出；
 * 这里用一个假 window 跑它，拿到同一份 API。
 *
 * 跑法：node tools/test-markdown.mjs（npm test 里会顺带跑）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(ROOT, 'compose/markdown.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', code)(sandbox.window);
const md = sandbox.window.__tcsMarkdown;

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

const html = md.toHtml;
const looks = md.looksLikeMarkdown;

console.log('\n[块级]');
check('标题层级', () => {
  assert.equal(html('# 一级'), '<h1>一级</h1>');
  assert.equal(html('### 三级 ###'), '<h3>三级</h3>');
});
check('段落用 p，两行合并成一个段落', () => {
  assert.equal(html('第一行\n第二行'), '<p>第一行第二行</p>');
});
check('中文换行不加空格，英文加', () => {
  assert.equal(html('中文\n继续'), '<p>中文继续</p>');
  assert.equal(html('hello\nworld'), '<p>hello world</p>');
});
check('行尾两空格 = 硬换行', () => {
  assert.equal(html('上一行  \n下一行'), '<p>上一行<br>下一行</p>');
});
check('围栏代码内不解析标记', () => {
  const out = html('```js\nconst a = 1 * 2 * 3; // **不是粗体**\n```');
  assert.ok(out.startsWith('<pre'));
  assert.ok(out.includes('**不是粗体**'), '代码内容应原样保留');
  assert.ok(out.includes('class="language-js"'));
  assert.ok(!out.includes('<strong>'));
});
check('围栏代码里的 < 被转义', () => {
  assert.ok(html('```\nif (a < b && c > d) {}\n```').includes('&lt;'));
});
check('无序列表', () => {
  assert.equal(html('- 一\n- 二'), '<ul><li>一</li><li>二</li></ul>');
});
check('有序列表带起始号', () => {
  assert.equal(html('3. 三\n4. 四'), '<ol start="3"><li>三</li><li>四</li></ol>');
});
check('嵌套列表挂到父项里', () => {
  const out = html('- 父\n  - 子');
  assert.ok(/<ul><li>父<ul><li>子<\/li><\/ul><\/li><\/ul>/.test(out), out);
});
check('任务列表换成字符（邮件里不能有 input）', () => {
  assert.equal(html('- [ ] 未做\n- [x] 已做'),
    '<ul><li>\u2610 未做</li><li>\u2611 已做</li></ul>');
});
check('GFM 表格 + 对齐 + inline 边框', () => {
  const out = html('| 名 | 数 |\n|:---|---:|\n| a | 1 |');
  assert.ok(out.includes('<table style="border-collapse:collapse;'));
  assert.ok(out.includes('<th style="border:1px solid #c9c9c9;padding:4px 8px;' +
    'background:#f5f5f5;font-weight:600;text-align:left;">名</th>'), out);
  assert.ok(out.includes('text-align:right;') || out.includes('text-align:right'));
  assert.ok(out.includes('<td'), '应有数据行');
});
check('表格少列补空、多列丢弃', () => {
  const out = html('| a | b |\n|---|---|\n| 1 |');
  assert.equal((out.match(/<td/g) || []).length, 2);
});
check('引用块', () => {
  const out = html('> 引用一行\n> 引用两行');
  assert.ok(out.startsWith('<blockquote style="border-left:2px solid #d0d0d0;'));
  assert.ok(out.includes('<p>引用一行引用两行</p>'), out);
});
check('水平线', () => {
  assert.equal(html('---'), '<hr>');
  assert.equal(html('* * *'), '<hr>');
});

console.log('\n[行内]');
check('粗体 斜体 删除线', () => {
  assert.equal(html('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(html('*斜*'), '<p><em>斜</em></p>');
  // 删除线走 span + text-decoration：与 TinyMCE 自己的 strikethrough 主格式一致
  assert.equal(html('~~删~~'),
    '<p><span style="text-decoration:line-through;">删</span></p>');
});
check('三星号 = 粗斜', () => {
  assert.equal(html('***都***'), '<p><strong><em>都</em></strong></p>');
});
check('行内代码里的星号不算粗体', () => {
  assert.equal(html('`a ** b`'),
    '<p><code style="font-family:Consolas,Menlo,\'Courier New\',monospace;' +
    'font-size:0.92em;background:#f3f4f6;border:1px solid #e3e6ea;border-radius:3px;' +
    'padding:0 3px;">a ** b</code></p>');
});
check('链接', () => {
  assert.equal(html('[名](https://a.com)'), '<p><a href="https://a.com">名</a></p>');
});
check('图片带 inline max-width', () => {
  const out = html('![图](https://a.com/x.png)');
  assert.ok(out.includes('<img src="https://a.com/x.png" alt="图"'));
  assert.ok(out.includes('max-width:100%;height:auto;'));
});
check('javascript: 链接被拒，只留文字', () => {
  const out = html('[点我](javascript:alert(1))');
  assert.ok(!out.includes('href'), out);
  assert.ok(out.includes('点我'));
});
check('正文里的 <script> 一律转义', () => {
  const out = html('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});
check('反斜杠转义星号', () => {
  assert.equal(html('\\*不是斜体\\*'), '<p>*不是斜体*</p>');
});
check('5*3*2 不当斜体', () => {
  assert.equal(html('5*3*2'), '<p>5*3*2</p>');
});

console.log('\n[还原纯文本]');
const plain = md.htmlToPlain;
check('纯文本被包成 p/div/br 时能还原', () => {
  assert.equal(plain('<p>第一行</p><p>第二行</p>'), '第一行\n第二行');
  assert.equal(plain('第一行<br>第二行'), '第一行\n第二行');
  assert.equal(plain('<div>a</div><div><br></div><div>b</div>'), 'a\n\nb');
});
check('带真 HTML 标签的一律不认（返回 null）', () => {
  assert.equal(plain('<p>看这里 <strong>重点</strong></p>'), null);
  assert.equal(plain('<p style="color:red">红字</p>'), null);
  assert.equal(plain('<span>来自网页</span>'), null);
  assert.equal(plain('<table><tr><td>1</td></tr></table>'), null);
});
check('实体还原正确，且 &amp;lt; 不被拆成小于号', () => {
  assert.equal(plain('<p>a &lt; b &amp; c</p>'), 'a < b & c');
  assert.equal(plain('<p>&amp;lt;</p>'), '&lt;');
  assert.equal(plain('<p>换&nbsp;行</p>'), '换 行');
});
check('空输入返回空串，不是 null', () => {
  assert.equal(plain(''), '');
  assert.equal(plain(null), '');
});

console.log('\n[检测器]');
check('典型 md 片段要转', () => {
  assert.equal(looks('# 标题\n## 小节\n正文 **重点**'), true);
  assert.equal(looks('- a\n- b\n- c'), true);
  assert.equal(looks('| a | b |\n|---|---|\n| 1 | 2 |'), true);
  assert.equal(looks('```\ncode\n```'), true);
  assert.equal(looks('> 一\n> 二\n> 三'), true);
});
check('普通邮件正文不转', () => {
  assert.equal(looks('你好，附件是报价单，请查收。'), false);
  assert.equal(looks('今天开会讨论了三件事：\n预算、排期、人手。'), false);
  assert.equal(looks('Regards,\nEdwin'), false);
});
check('纯分隔线不转（签名常见）', () => {
  assert.equal(looks('----------'), false);
  assert.equal(looks('————'), false);
});
check('单个短标题也不转（太像正文）', () => {
  assert.equal(looks('# 123'), false);
});
check('空/超长直接拒', () => {
  assert.equal(looks(''), false);
  assert.equal(looks('x'.repeat(200001)), false);
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) process.exit(1);
