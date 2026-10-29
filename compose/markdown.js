/**
 * 写信增强 BetterCompose — Markdown 粘贴转换
 *
 * 为什么自己写：TinyMCE 官方的 markdown 插件是付费订阅专属（GPL 包里连
 * `plugins/markdown` 目录都没有，tinymce.min.js 里 `markdown` 字样出现 0 次），
 * 而它干的事其实只有三件 —— 判断粘进来的是不是纯 markdown、转成 HTML、
 * 压一个 undo 层。前两件在这个文件里，第三件由 inject.js 的 paste_preprocess
 * 交给 TinyMCE 自己的 undoManager。
 *
 * 三条硬约束（都是邮件场景逼出来的）：
 *   1. 不依赖任何库、不发网络请求 —— 撰写窗口的资源必须全在扩展包里
 *   2. 不依赖 DOM —— 纯字符串进出，node 里能直接跑断言（tools/test-markdown.mjs）
 *   3. 样式一律 inline —— 收件端大多不认 <style>，这点和 md-clip 的结论一致
 *
 * 导出（挂在 window.__tcsMarkdown，由 background.js 按顺序先于 inject.js 注入）：
 *   looksLikeMarkdown(text) -> boolean   要不要转
 *   toHtml(text)            -> string    转成 HTML 片段（空串表示没转出东西）
 *   version                 -> string
 *
 * 覆盖范围（GFM 的常用子集，够写信，不追求完整规范）：
 *   块级：ATX 标题 / 围栏代码 / GFM 表格 / 引用 / 嵌套列表（含任务列表）/ 水平线 / 段落
 *   行内：粗体 斜体 删除线 行内代码 链接 图片 / 硬换行（行尾两空格或反斜杠）
 * 不做的：setext 标题（=== / --- 下划线式，与水平线歧义）、脚注、定义列表、
 *         引用式链接、HTML 块直通（一律当文本转义，避免把 <script> 带进正文）
 */
(function (root) {
  'use strict';

  // 与 manifest.json 的 version 保持一致。这个模块是纯函数（node 里直接断言，
  // 拿不到 browser.runtime），只能写字面量，所以靠 tools/check-static.mjs 第 9 节
  // 核对两处是否相等 —— 免得面板上显示一个版本、about:addons 里是另一个。
  var VERSION = '1.0.0';

  // ── 基础工具 ────────────────────────────────────────────────────────────────
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return ESC[c]; });
  }

  // 中日韩字符：用于判断软换行合并时要不要补空格。
  // 中文两行接起来不该出现 "中文 中文" 里那个空格，英文两行则必须有。
  function isCJK(ch) {
    return /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch || '');
  }

  // 链接/图片来源白名单。javascript: 与 data: 一律拒（data: 图片在邮件里
  // 会被当内联附件，而且体积失控，不走这条路）。
  function safeUrl(u) {
    var s = String(u || '').trim();
    if (!s) return false;
    if (/^(https?:|mailto:|cid:|#|\.{0,2}\/)/i.test(s)) return true;
    // 裸域名/相对路径也放行（邮件里常见 example.com/a.png）
    return !/^[a-z][a-z0-9+.-]*:/i.test(s);
  }

  // ── 行内 ────────────────────────────────────────────────────────────────────
  // 顺序很重要：
  //   1. 先把行内代码与反斜杠转义抽成占位符 —— 否则 `**` 出现在代码里会被当粗体
  //   2. 再整体做 HTML 转义 —— 之后拼进去的标签都是我们自己生成的
  //   3. 图片/链接 → 粗斜体/删除线
  //   4. 占位符还原
  var PH_CODE = '\u0001C';
  var PH_ESC = '\u0001E';

  function inline(text) {
    var s = String(text == null ? '' : text);
    var codes = [];
    var escs = [];

    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push(c);
      return PH_CODE + (codes.length - 1) + '\u0001';
    });

    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, function (_, c) {
      escs.push(c);
      return PH_ESC + (escs.length - 1) + '\u0001';
    });

    s = escapeHtml(s);

    // 图片：![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, alt, src, title) {
        if (!safeUrl(src)) return alt;
        return '<img src="' + src + '" alt="' + alt + '"' +
          (title ? ' title="' + title + '"' : '') +
          ' style="max-width:100%;height:auto;">';
      });

    // 链接：[text](href "title")
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g,
      function (m, text, href, title) {
        if (!safeUrl(href)) return text;
        return '<a href="' + href + '"' +
          (title ? ' title="' + title + '"' : '') + '>' + text + '</a>';
      });

    // 删除线用 span + text-decoration，而不是 <del>：
    // TinyMCE 7 的 strikethrough 主格式就是 { inline:'span', styles:{textDecoration:'line-through'} }
    // （bundle 里 strikethrough 的那段定义，fallback 才是 <strike>）。用同一种形态，
    // 一是过 schema 时不会被改写成别的，二是用户再点一次删除线按钮能正确「取消」，
    // 否则 <del> 和 span 两套格式会互相盖不住。
    s = s.replace(/~~([^~\n]+)~~/g, '<span style="text-decoration:line-through;">$1</span>');

    // 三星号最优先，否则 ** 会把 ***x*** 吃成 <strong>*x*</strong>
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/___([^_\n]+)___/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    // 单星号：前后不能紧贴字母数字，避免把 5*3*2 当成斜体
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

    // 占位符还原（代码内容仍要转义，转义字符是字面量符号，原样放回）
    s = s.replace(new RegExp(PH_CODE + '(\\d+)\u0001', 'g'), function (_, n) {
      return '<code style="' + CODE_INLINE + '">' + escapeHtml(codes[+n]) + '</code>';
    });
    s = s.replace(new RegExp(PH_ESC + '(\\d+)\u0001', 'g'), function (_, n) {
      return escapeHtml(escs[+n]);
    });

    return s;
  }

  // ── 样式常量：全是 inline，收件端不认 <style> ──────────────────────────────
  // 注意字体名的引号：整段样式要塞进 style="…" 里，用双引号会把属性提前截断
  // （style 只剩下 font-family:Consolas,Menlo, 那一截，后面的全丢）。单引号在
  // 双引号属性里是合法的 CSS 字体名写法。
  var CODE_INLINE =
    "font-family:Consolas,Menlo,'Courier New',monospace;font-size:0.92em;" +
    'background:#f3f4f6;border:1px solid #e3e6ea;border-radius:3px;padding:0 3px;';
  var PRE =
    "font-family:Consolas,Menlo,'Courier New',monospace;font-size:13px;" +
    'line-height:1.5;background:#f6f8fa;border:1px solid #e3e6ea;border-radius:3px;' +
    'padding:8px 10px;margin:0 0 10px;white-space:pre-wrap;word-break:break-word;';
  var QUOTE =
    'border-left:2px solid #d0d0d0;margin:8px 0;padding:0 0 0 10px;color:#555;';
  var TABLE = 'border-collapse:collapse;margin:0 0 10px;';
  var TH = 'border:1px solid #c9c9c9;padding:4px 8px;background:#f5f5f5;font-weight:600;';
  var TD = 'border:1px solid #c9c9c9;padding:4px 8px;';

  // ── 块级 ────────────────────────────────────────────────────────────────────
  function indentOf(line) {
    var m = line.match(/^[ \t]*/);
    return m[0].replace(/\t/g, '    ').length;
  }

  var LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

  function isDelimiterRow(line) {
    if (!line || line.indexOf('-') < 0) return false;
    var cells = splitRow(line);
    if (!cells.length) return false;
    return cells.every(function (c) { return /^:?-+:?$/.test(c.trim()); });
  }

  function splitRow(line) {
    var s = String(line).trim();
    s = s.replace(/^\|/, '').replace(/\|$/, '');
    var cells = [];
    var buf = '';
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (ch === '\\' && s[k + 1] === '|') { buf += '|'; k++; continue; }
      if (ch === '|') { cells.push(buf); buf = ''; continue; }
      buf += ch;
    }
    cells.push(buf);
    return cells;
  }

  // 这一行会不会开启一个新的块（供段落循环判断何时停）
  function startsBlock(lines, i) {
    var line = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(line)) return true;
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return true;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
    if (/^\s{0,3}>/.test(line)) return true;
    if (LIST_RE.test(line)) return true;
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) return true;
    return false;
  }

  function paragraph(lines) {
    var toks = [];
    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k];
      var hard = /(?: {2,}|\\)$/.test(ln);
      var t = ln.replace(/(?: {2,}|\\)$/, '');
      if (k > 0 && typeof toks[toks.length - 1] === 'string') {
        var prevCh = toks[toks.length - 1].slice(-1);
        if (!(isCJK(prevCh) && isCJK(t.charAt(0)))) toks.push(' ');
      }
      toks.push(t);
      if (hard) toks.push({ br: true });
    }
    var html = '';
    var buf = '';
    var flush = function () {
      if (buf) { html += inline(buf); buf = ''; }
    };
    toks.forEach(function (t) {
      if (typeof t === 'string') { buf += t; return; }
      flush();
      html += '<br>';
    });
    flush();
    return '<p>' + html + '</p>';
  }

  function codeBlock(lines, lang) {
    var body = escapeHtml(lines.join('\n'));
    var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    return '<pre style="' + PRE + '"><code' + cls + '>' + body + '</code></pre>';
  }

  function table(lines, i) {
    var head = splitRow(lines[i]);
    var aligns = splitRow(lines[i + 1]).map(function (c) {
      var t = c.trim();
      var l = t.charAt(0) === ':';
      var r = t.charAt(t.length - 1) === ':';
      return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    var j = i + 2;
    var rows = [];
    while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') >= 0) {
      if (startsBlock(lines, j) && !isDelimiterRow(lines[j])) break;
      rows.push(splitRow(lines[j]));
      j++;
    }

    var cellStyle = function (base, idx, isHead) {
      var a = aligns[idx] ? 'text-align:' + aligns[idx] + ';' : (isHead ? 'text-align:left;' : '');
      return ' style="' + base + a + '"';
    };

    var html = '<table style="' + TABLE + '"><thead><tr>';
    head.forEach(function (c, idx) {
      html += '<th' + cellStyle(TH, idx, true) + '>' + inline(c.trim()) + '</th>';
    });
    html += '</tr></thead>';
    if (rows.length) {
      html += '<tbody>';
      rows.forEach(function (cells) {
        html += '<tr>';
        // 列数以表头为准：少的补空，多的丢掉（GFM 的行为）
        for (var c = 0; c < head.length; c++) {
          html += '<td' + cellStyle(TD, c, false) + '>' +
            inline((cells[c] || '').trim()) + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody>';
    }
    html += '</table>';
    return [html, j];
  }

  function list(lines, i, baseIndent) {
    var first = lines[i].match(LIST_RE);
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [];

    while (i < lines.length) {
      var m = lines[i].match(LIST_RE);
      if (!m) break;
      var ind = indentOf(lines[i]);
      if (ind < baseIndent) break;

      // 缩进更深 = 嵌套，递归后挂到当前这一项下面
      if (ind > baseIndent) {
        if (!items.length) break;
        var sub = list(lines, i, ind);
        items[items.length - 1].sub.push(sub[0]);
        i = sub[1];
        continue;
      }
      // 有序/无序混排：不合并，交给上层当新块
      if (/\d/.test(m[2]) !== ordered) break;

      items.push({ text: m[3], sub: [] });
      i++;

      // 续行：缩进着、又不开启新块的行，属于当前项
      while (i < lines.length && lines[i].trim() &&
             !LIST_RE.test(lines[i]) && !startsBlock(lines, i)) {
        items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
    }

    var tag = ordered ? 'ol' : 'ul';
    var attr = (ordered && start !== 1) ? ' start="' + start + '"' : '';
    var body = items.map(function (it) {
      var t = it.text;
      // 任务列表：邮件里不能用 <input>（会被清洗），换成字符
      var task = t.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      if (task) {
        t = (task[1] === ' ' ? '\u2610 ' : '\u2611 ') + task[2];
      }
      return '<li>' + inline(t) + it.sub.join('') + '</li>';
    }).join('');

    return ['<' + tag + attr + '>' + body + '</' + tag + '>', i];
  }

  function blocks(lines) {
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      // 围栏代码（``` 或 ~~~，闭合标记必须同字符且不短于开头）
      var fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/);
      if (fence) {
        var mark = fence[1].charAt(0);
        var len = fence[1].length;
        var buf = [];
        i++;
        while (i < lines.length) {
          var close = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
          if (close && close[1].charAt(0) === mark && close[1].length >= len) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        out.push(codeBlock(buf, fence[2]));
        continue;
      }

      // ATX 标题（结尾的 ### 是装饰，去掉）
      var h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*$/);
      if (h) {
        var lv = h[1].length;
        var txt = h[2].replace(/\s+#+\s*$/, '');
        out.push('<h' + lv + '>' + inline(txt) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 水平线（三个以上同类符号，中间可夹空格）
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // 表格：当前行有竖线 + 下一行是分隔行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
        var tb = table(lines, i);
        out.push(tb[0]);
        i = tb[1];
        continue;
      }

      // 引用：连续的 > 行；碰上非 > 但非空的行算 lazy continuation
      if (/^\s{0,3}>/.test(line)) {
        var qbuf = [];
        while (i < lines.length) {
          if (/^\s{0,3}>/.test(lines[i])) {
            qbuf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
            i++;
          } else if (lines[i].trim() && qbuf.length) {
            qbuf.push(lines[i]);
            i++;
          } else break;
        }
        out.push('<blockquote style="' + QUOTE + '">' + blocks(qbuf).join('') + '</blockquote>');
        continue;
      }

      // 列表
      if (LIST_RE.test(line)) {
        var ls = list(lines, i, indentOf(line));
        out.push(ls[0]);
        i = ls[1];
        continue;
      }

      // 段落：一直吃到空行或下一个块的起点
      var pbuf = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        pbuf.push(lines[i]);
        i++;
      }
      // 兜底：万一当前行本身就"像块起点"却没被上面任何分支接住，
      // 至少消费一行，否则外层 while 会原地打转
      if (!pbuf.length) {
        pbuf.push(lines[i]);
        i++;
      }
      out.push(paragraph(pbuf));
    }

    return out;
  }

  function toHtml(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!src.trim()) return '';
    return blocks(src.split('\n')).join('\n');
  }

  // ── 从 TinyMCE 的 content 里还原纯文本 ────────────────────────────────────
  // PastePreProcess 拿到的 content 已经是 HTML 了：纯文本粘贴会被 TinyMCE 包成
  // <p>/<div>/<br>。要判断「这本来就是纯文本」就必须先还原，否则解析器看到的
  // 是标签不是 markdown。
  //
  // 返回 null 表示这份 content 里有真 HTML 标签 —— 剪贴板本来就带格式，
  // 不属于 markdown 转换的管辖范围，调用方应原样放行。
  // 只认 p/div/br：span 一出现就说明来源带样式（Word、网页都爱用 span）。
  var ONLY_TEXT_TAGS = /<\/?(?:p|div|br)\s*\/?>/gi;

  function htmlToPlain(html) {
    var s = String(html == null ? '' : html);
    if (/<\/?[a-z][^>]*>/i.test(s.replace(ONLY_TEXT_TAGS, ''))) return null;
    return s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      // &amp; 必须最后还原：否则 &amp;lt; 会被拆成 &lt; 再变成 <
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── 要不要转：打分 ──────────────────────────────────────────────────────────
  // 误转（把一段普通正文套成 h1/p）比漏转更烦，所以结构类信号按"行数"累计，
  // 光靠一两个 ** 加粗不够格。阈值调过两轮：三项以上的列表、三条以上的引用、
  // 一个标题 + 一个行内标记，都能过；单独的 -------- 分隔线过不了。
  function looksLikeMarkdown(text) {
    var src = String(text == null ? '' : text);
    if (src.length < 4 || src.length > 200000) return false;

    var lines = src.replace(/\r\n?/g, '\n').split('\n');
    var heading = 0, fence = 0, table = 0, listItems = 0, quote = 0;
    var bold = 0, codeSpan = 0, link = 0;

    for (var k = 0; k < lines.length; k++) {
      var ln = lines[k];
      if (/^\s{0,3}#{1,6}\s+\S/.test(ln)) heading++;
      if (/^\s{0,3}(`{3,}|~{3,})/.test(ln)) fence++;
      if (/^\s{0,3}>\s?/.test(ln)) quote++;
      if (LIST_RE.test(ln)) listItems++;
      if (ln.indexOf('|') >= 0 && k + 1 < lines.length && isDelimiterRow(lines[k + 1])) table++;
    }
    if (/\*\*[^*\n]+\*\*/.test(src) || /__[^_\n]+__/.test(src)) bold = 1;
    if (/`[^`\n]+`/.test(src)) codeSpan = 1;
    if (/\[[^\]\n]+\]\([^)\s]+\)/.test(src)) link = 1;

    var structScore = heading * 2 + fence * 3 + table * 3 + listItems + quote;
    var inlineScore = bold + codeSpan + link;

    return structScore >= 3 || (structScore >= 2 && inlineScore >= 1);
  }

  var api = {
    version: VERSION,
    toHtml: toHtml,
    looksLikeMarkdown: looksLikeMarkdown,
    htmlToPlain: htmlToPlain,
    // 测试用：拿到段落/表格的解析中间态不值得暴露，这里只给常量校验
    _styles: { TD: TD, TH: TH, PRE: PRE },
  };

  root.__tcsMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
