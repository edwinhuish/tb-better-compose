# 写信增强 BetterCompose

用 TinyMCE 7 的内联编辑器接管 Thunderbird 撰写窗口的正文区，并把工具栏压成**一行**、
把功能收进**左侧一个折叠菜单**、让图片走 **Thunderbird 自己的附件通路**而不是往正文里塞 base64。

不改 Thunderbird 的窗口结构，也不动安装目录，只替换写信这一段的编辑体验。
注入策略沿用 [雷霆笔 Thunderpen](https://github.com/kencncmis-spec/Thunderpen)（MIT）的结论
（CSP 不允许外链脚本，只能 fetch + 间接 eval），界面、图片链路与其余功能独立实现。
这是独立扩展，与 Betterbird 只是命名调性相近，没有从属关系。

- 最低 Thunderbird 115（`browser_specific_settings.gecko.strict_min_version`）
- 自带 TinyMCE 7.9.3，所有资源都在包内，断网可用
- 只申请 `compose` 与 `storage` 两个权限，不联网、不收集数据

---

## 1. 工具栏：一行 18 个按钮

`menubar` 关掉、`toolbar_mode: 'sliding'`，溢出项收进右侧「更多」，永不换行。
默认顺序（`|` 只是分组，不改变顺序）：

```
菜单 ▾ | 撤销 重做 | 字体 ▾ 10.5pt ▾ | 字体色 ▾ 背景色 ▾ | 删除线 格式刷 清除格式 |
左 中 右 | 有序 无序 | 表格 ▾ | 😊 | <>
```

| 按钮 | 实现 | 说明 |
|---|---|---|
| 菜单 | 自定义 `tcs_menu`（menubutton） | 全部功能收在里面，见第 2 节 |
| 撤销 / 重做 | 内置 `undo` / `redo` | 提到工具栏 |
| 字体 | 自定义 `tcs_font`（menubutton） | 10 项；按钮显示当前字体，下拉里当前项带勾 |
| 字体大小 | 自定义 `tcs_size`（menubutton） | 默认 + 10pt/11/12/14/16/18/20/24/28/36pt；按钮显示当前字号 |
| 字体颜色 | 内置 `forecolor`（拆分按钮） | 主键套用上次的颜色，箭头开 22 色板 |
| 背景颜色 | 内置 `backcolor`（拆分按钮） | 同上，作用在 `background-color` |
| 删除线 | 内置 `strikethrough` | |
| 格式刷 | 自定义 `tcs_fp`（toggle） | 复用内置 `format-painter` 图标，见第 4 节 |
| 清除格式 | 内置 `removeformat` | |
| 左 / 中 / 右对齐 | 自定义 `tcs_align_l` / `_c` / `_r`（toggle） | 三个平铺图标，互斥点亮；命令仍是 `JustifyLeft/Center/Right` |
| 有序列表 | 内置 `numlist` | `advlist` 下是拆分按钮，箭头选 1. / a. / i. / A. / I. |
| 无序列表 | 内置 `bullist` | 箭头选实心圆 / 空心圆 / 实心方块 |
| 表格 | 内置 `table` | 插件自带下拉：插入表格 / 行增删 / 列增删 / 合并拆分 |
| 表情 | 自定义 `tcs_emoji` | 面板来自 `emoticons` 插件（九分类 + 搜索），插入 **unicode 字符** |
| 源代码 | 内置 `code` | 源码对话框；菜单「视图 → HTML 源码…」是同一命令 |

### 为什么是一行

只给 `.tox-toolbar` 加 `flex-wrap: nowrap` 不够：总宽超限时 flex 会先压窄每个**按钮组**
（`flex-shrink` 默认 1），组内按钮竖着堆成 2~3 行。`compose/shell.css` 因此给三层容器加
`nowrap`，并给 `.tox-toolbar__group` 加 `flex: 0 0 auto`，超出的部分才轮到 `sliding` 收走。

`sliding` 是**按组**收缩的，所以尾部「表格 / 表情 / 源码」各自单独成组：并成一组时同宽会同时消失三个。
窗口足够宽（约 900px 以上，具体取决于系统字体）时 18 个全部可见；再窄就按组从尾部进「更多」，
**始终一行**。每加一个按钮，这个宽度阈值随之上移。

> 不要试图用 padding 收窄图标按钮：TinyMCE 给它们写的是内联 `style="width:34px"`，
> 只有 `width !important` 能压，而那会与它自己的滑出计算冲突。

### 字体 / 字号：按钮上显示当前值

`menubutton` 的 `text` 是注册时定死的常量，TinyMCE 7 的按钮实例 API 只有 `setEnabled` / `setActive`，
没有 `setText`，所以标签直接改 DOM 上的 `.tox-tbtn__select-label`（按钮带 `data-mce-name`）。

初始 `text` 必须写「默认状态下的真实值」（`系统默认` / `10.5pt`）：TinyMCE 渲染时按初始 text
量一个内联 width 定死，写占位词会让后面的值被 ellipsis 截掉。

当前值取自选区起点元素的 `getComputedStyle`，不是 formatter 记录 —— 粘贴进来或别人发来的
`<span style="font-family:宋体">` 没走过我们的 formatter，但计算样式一定有。字体只比第一段族名
（声明里带一长串 fallback），字号把 px 折回 pt（正文 14px = 10.5pt）。

### 对齐为什么平铺

对齐是高频且互斥的动作，多一层「对齐 ▾」下拉等于每次多一次点击，且下拉按钮上只有一个「对齐」，
看不出当前段落对哪边。三个 `toggleButton` 的 active 态由 `formatter.match('alignleft'/…)` 决定。
代价是宽度（约 38px），阈值随之上移。

### 颜色：一份调色板，三个入口

`PALETTE` 是唯一来源：工具栏两个色板（`color_map`）、菜单里的「文字颜色」、菜单里「标红」的红色
都从它派生，同一个「红」在哪儿点都是 `#E03E2D`。

色板用官方那 22 色（5 列 × 4 行 + 末行黑白），顺序本身就是官方分行逻辑，不要重排：

```
浅绿 浅黄 浅红 浅紫 浅蓝      ← 浅底（做背景色最常用）
绿   黄   红   紫   蓝        ← 标准
深青 橙   暗红 深紫 深蓝      ← 深底
浅灰 中灰 灰   深灰 藏青      ← 灰阶
黑   白                       ← 黑白
```

色名写中文直接进语言包：色板项的 `text` 会过 TinyMCE 的 `translate()`，语言包里没有的名字原样输出，
写 `'Red'` 反而会在中文界面里冒出英文单词。菜单里的「文字颜色」同样是这 22 项，每 5 个切一条分隔线。

`TinyMCE 7` 已把 `textcolor` 并进核心（`mceApplyTextcolor` / `mceRemoveTextcolor`、`forecolor` /
`hilitecolor` 两个格式器、拆分按钮与色板都在 core 与 silver 主题里），所以一个插件文件都不用加。

### 选色器：给 canvas 垫一层等价的 CSS 渐变

色板右下角「自定义颜色」打开 TinyMCE 的选色器，左侧饱和度/亮度面板是 silver 主题用 `<canvas>`
现画的三层：`hsl(hue,100%,50%)` 铺底、左白右透明、上透明下黑。这套在 Gecko 里实测是整片空白
（几何位置全对、只有 canvas 没内容），而绘制发生在 TinyMCE 内部的 `onInit`，失败点不可控。

所以不碰绘制，改在 canvas **底下**垫等价的三层 CSS 渐变（`compose/shell.css`）：

```css
.tox-sv-palette .tox-sv-palette-spectrum {
  background-color: hsl(var(--tcs-hue, 0), 100%, 50%);
  background-image:
    linear-gradient(to bottom, rgba(0,0,0,0), #000),
    linear-gradient(to right, #fff, rgba(255,255,255,0));
  min-height: 160px;
}
```

canvas 画得出来时第一层 `fillRect` 就盖满画布、背景看不见；画不出来时背景直接充当面板。
顺序与 canvas 对齐——canvas 先白渐变后黑渐变，所以黑在上，`background-image` 第一项写黑色渐变。

色相拿不到内部状态（silver 存在组件的 `paletteHue` 里），唯一出口是色相条的 `aria-valuenow`
（`Math.floor(360 - 3.6 * y)`，与内部 hue 同值）。`inject.js` 观察它写进 `--tcs-hue`；
初始值固定 0、不读属性（那个 `120` 是写死的假值）。

### 按钮为什么是直角

TinyMCE 皮肤给工具栏按钮 3px 圆角、给整体框 10px，按钮多起来像一排小胶囊，与 TB 自己的工具条不是一路。
`shell.css` 把工具栏内的整体框、按钮组、`.tox-tbtn`、拆分按钮及其 `:hover` / `:active` / `:focus`
连同 `:focus::after` 的焦点环统一归零，作用域只在工具栏内。

这里**必须带 `!important`**：工具栏搬进 shadow root 后 `#tcs-toolbar` 被换成 `:host`，特异性从 (1,1,0)
掉到 (0,2,0)，而皮肤那条 `.tox.tox-tinymce-inline .tox-editor-header` 是 (0,3,0) 且带 `overflow:hidden`，
不加权重就会被重新裁成一块圆角卡片。这种偏差在普通文档里复现不出来，所以 `tools/check-static.mjs`
第 10 节做静态断言：每条 `border-radius` 必须是 `0 !important`，且覆盖 `.tox-editor-header` 与 `::after`。

---

## 2. 功能收进一个折叠菜单

工具栏最左边只有一个「**菜单**」，顶层结构：

```
撤销 / 重做
──────────────
剪贴板 ▸   剪切 复制 粘贴 全选
格式   ▸   段落格式 ▸ | 标红 | 文字颜色 ▸ | 背景高亮 ▸ | 字号 ▸ |
           粗体 斜体 下划线 删除线 | 左 中 右 | 有序 无序 | 清除格式
插入   ▸   图片 链接 表格 | 分隔线 特殊字符 日期 时间 锚点
表格   ▸   插入表格 | 行增删 | 列增删 | 合并拆分 | 删除表格
视图   ▸   HTML 源码 / 全屏 / 显示块级边框
──────────────
查找替换…
```

二级用 `nestedmenuitem` 折进去。TinyMCE 7 的字段名是 `getSubmenuItems`（6.x 是 `getSubmenu`），
写错会在菜单打开瞬间抛 `getSubmenuItems is not a function`。

为什么不排五个并排的 menubutton（编辑/格式/插入/表格/视图）：它们本身吃掉 300 多 px，
窗口一窄右侧按钮就被收进「更多」；收成一个按钮后横向占用从 5 降到 1，功能一项没少。

粗体 / 斜体 / 下划线不在工具栏上（它们在「格式」组里）。要放回工具栏，改配置里的 `toolbar`
即可，例如：

```
tcs_menu | undo redo | bold italic underline | tcs_font tcs_size | …
```

---

## 3. 图片按 Thunderbird 的规则走

Thunderbird 的判定写在 `EdImageLinkLoader.js` 里，落到 DOM 上就是一个属性：**`moz-do-not-send`**。

插入时仍用 `data:` 做**编辑器内预览**（TB 自己的图片对话框也这么干），序列化时按来源补标记：

| `src` | 标记 | 结果 |
|---|---|---|
| `data:` / `file:` / 其它非 http 源 | `false` | 交给 TB 转成 MIME 部件（TB 自己生成 `cid:`） |
| `http(s):` | `true` | 保持远程引用，不偷偷下载 |
| `cid:` | 不动 | 已经是原生内联件 |

TinyMCE 默认白名单会删掉这个属性，所以 `extended_valid_elements` 里显式放行
`img[...|moz-do-not-send]`；`code[style|class]` 也是同一处理，给 Markdown 粘贴的行内代码留样式。

不用 `compose.addAttachment` 自己造 `cid:`：WebExtension 层的 `ComposeAttachment` 只有
`id / name / size`，拿不到部件 ID，没法自己写 `cid:` 引用。让 TB 自己转换是唯一干净的路。

编辑器内始终存在 `data:` 预览图，草稿因此会偏大，这是预期行为。

---

## 4. 格式刷：可以连续刷

语义照 Word：

1. 选中要**取样**的文字，点工具栏的格式刷图标（按钮变亮、光标变十字）
2. 选中目标文字 —— 放开鼠标就套用
3. **不退出**，继续选下一段继续刷；再点按钮或按 `Esc` 结束

取样只收元素上**显式声明**的 `color` / `background-color` / `font-size` / `font-family`，
加上粗体、斜体、下划线、删除线。用 `getComputedStyle` 会把继承来的 `font-size:14px`、
`font-family:system-ui` 一起固化，刷完多出一串冗余 span，收件端字体一换就走样。

只覆盖**字符级**格式。段落级（对齐、缩进、列表）刻意不刷——硬刷会改坏目标段落结构。

---

## 5. 存草稿只留原文：工具栏住进 shadow root

Thunderbird 存草稿是把**整个编辑器文档**序列化出来的（`nsMsgCompose::SendMsg` 里
`m_editor->OutputToString("text/html", OutputFormatted | …)`，没有跳过不可见内容的开关），
序列化器从 `document` 一路遍历子节点，`display:none` 与 `contenteditable=false` 都挡不住；
compose API 又只有 `onAfterSave`、没有「保存之前」的事件。

所以换个思路：init 之后把 `#tcs-toolbar` 的整棵子树搬进它自己的 **shadow root**。
序列化走 light DOM、进不去 shadow tree，而渲染和事件完全正常。

必须一起处理的几点：

| 点 | 为什么 |
|---|---|
| `.tox-tinymce-aux`（菜单/对话框的 sink） | 它本来就在工具栏子树里，跟着进 shadow，弹出层于是也不进草稿 |
| 样式 | shadow 拿不到文档样式表，把 `skin.min.css` 与 `shell.css` 内联进去 |
| `shell.css` 里的 `#tcs-toolbar` → `:host` | 不替换的话单行、`nowrap`、分组竖线全失效 |
| 用 `adoptedStyleSheets` 而不是 `<style>` | 撰写窗口的 CSP 管 `style-src`，CSSOM 对象不经那一关（不支持时退回 `<style>`） |
| 自检 + 回滚 | 搬完数一下 `.tox-tbtn`，没有就退回 light DOM（shadow 里的 `slot` 保证退回后仍可见） |

草稿正文里剩下的是：

```html
<div id="tcs-toolbar" data-tcs-ui="1" contenteditable="false"></div>
<div id="tcs-content">…原文…</div>
```

这两个空壳拆不掉：TinyMCE 必须有一个挂在正文文档里的容器（inline 模式的根），工具栏也需要渲染宿主。
**TinyMCE 自己的 DOM 一个都不剩**，这就是这一节要保证的事。

`cleanStale()` 会拆掉旧草稿里可能残留的 `#tcs-content` 与 `[data-tcs-ui]` / `tox-*` 节点，
内容原样还给 body，否则每存一次就多套一层壳。

---

## 6. 回复 / 转发与注入时序

`composeScripts` 注入得很早，而回复 / 转发时 `ComposeWindow` 是在正文文档加载**之后**才把引用原文
写进 `contentDocument.body`（一句 `body.innerHTML = …`）。那次写入会把刚插进去的
`#tcs-toolbar` / `#tcs-content` 一起冲掉，TinyMCE 于是绑在一个脱离文档的容器上：
表现是「一直停在加载中」，或者「工具栏在、正文没了」。

两处处理：

- **搭壳前等 body 静默**：`MutationObserver` 等连续 250ms 没有变化（最长 3.5s）再动手。
  不用轮询 `innerHTML` —— 引用正文可能上百 KB，反复序列化纯属浪费。
- **搭壳后继续守着**：TB 只要重写 body（引用迟到、切换「回复包含原文」的方式、插签名），
  就把工具栏与正文容器挂回去，并把新内容收进 `#tcs-content`。**不重新 init** ——
  TinyMCE 持有的是 `contentEl` 元素引用，元素回到文档就能继续用；重新 init 会丢撤销栈与光标。

纯文本撰写模式不接管：那种窗口里任何插入的节点都会原样进到邮件正文。

初始化失败时 TinyMCE 不派发 `init`，所以另有 8 秒看门狗 + 横幅，把失败原因写在界面上，
而不是永远挂着「加载中」。

---

## 7. 段落格式与配置

### 「正文文本」是 `div`，「段落」是 `p`

TinyMCE 的 `block_formats` 默认第一项是 `Paragraph=p`，中文语言包把 `Paragraph` 译成「段落」。
但 TB 自己的段落下拉本来就是两档：

| TB 的下拉项 | `value` | 行为 |
|---|---|---|
| 正文文本 | `""` | `goDoCommandParams("cmd_paragraphState", "")`，**没有任何块格式**，换行由 `editor.defaultParagraphSeparator`（默认 `div`）决定 |
| 段落 | `p` | `formatBlock p`，真正的 `<p>` |

出处是 `messengercompose.xhtml` 的 `toolbarmenu_bodyText` / `toolbarmenu_paragraph`，以及
`editor.js` 里 `if (state === "")` 旁边的原注释「Corresponds to body text」。
所以默认清单是 `正文文本=div;段落=p`，两档分得开；把 `forced_root_block` 钉成 `p` 反而会让
每封信都变成「段落」：TB 下拉认出 `p`、段间多出 `<p>` 的 margin、存出去每行一个 `<p>`。

菜单「格式 → 段落格式」有带勾选的项；另有 `tcs_block` 按钮（与字体/字号一样显示当前值），
**不在默认工具栏里**，需要时把 `'tcs_block'` 加进 `toolbar`。

### 三个配置项

| 名称 | 取值 | 默认值 | 作用 |
|---|---|---|---|
| `blockFormats` | `'名=标签;名=标签'` 或 `[['名','标签'], …]`；标签限 `p / div / h1–h6 / pre / blockquote` | `正文文本=div;段落=p;标题 1=h1;…;标题 6=h6;预格式化=pre` | 块格式清单：显示名、顺序、有哪些档 |
| `defaultBlockFormat` | 上面某个标签（小写） | `div` | 新建段落 / 空文档的标签（`forced_root_block`） |
| `toolbar` | 字符串或数组，空格分隔按钮、`\|` 分组 | 见第 1 节 | 显示哪些按钮、什么顺序 |

其余键：`markdownPaste`（默认 `true`）、`language`（默认 `'auto'`）、`debug`（默认 `false`）。

直接用控制台改（不打开选项页）：

```js
// Thunderbird 菜单「工具 → 开发者 → 调试附加组件 → 本扩展 → 检查」
// 执行后新开一个撰写窗口（配置只在 init 时读一次）
await browser.storage.local.set({
  'composeStudio.config': {
    blockFormats: '正文文本=div;引用=blockquote',
    defaultBlockFormat: 'blockquote',
    toolbar: 'tcs_menu | undo redo | tcs_block tcs_font tcs_size | ' +
             'forecolor backcolor strikethrough tcs_fp removeformat | ' +
             'tcs_align_l tcs_align_c tcs_align_r | numlist bullist | table',
  },
});

// 恢复默认
await browser.storage.local.remove('composeStudio.config');
```

只写想改的键，其余取默认。

### 写错了会怎样

规矩是**宁可少，不可崩**，每一条都有回退：

| 写错的形式 | 结果 |
|---|---|
| `toolbar` 里有拼错的按钮名 | 丢掉那一项，其余照常；控制台列出被忽略的名字 |
| `toolbar` 清空后一个有效按钮都不剩 | 回退默认那 18 个 |
| `blockFormats` 的标签不是块级标签（如 `script`） | 丢掉那一项 |
| `blockFormats` 整份都是坏值 | 回退默认清单 |
| `defaultBlockFormat` 不在清单里 | 回退 `div`；没有 `div` 就取第一项 |
| `storage` 不可用 / 读了 800ms 没回来 | 静默用全默认，不拦撰写窗口 |

为什么不用 TinyMCE 自己的容错：`forced_root_block` 给错值时它不报错，而是直接把正文塞进一个
奇怪元素——等问题被发现时草稿已经变形了。这类错误必须在进 init 之前挡掉。

### 对正文的影响

新写邮件的正文块是 `<div>`，段间距为 0，和 TB 不装插件时一致；已经存下的老草稿不受影响，
里面仍是 `<p>`，格式下拉会如实显示「段落」，想改就选「正文文本」。
`defaultBlockFormat` 改成别的值会改变存进草稿的 HTML，想清楚再改。

---

## 8. 粘贴 Markdown 自动变富文本

从 VS Code、Obsidian、GitHub issue 等处复制的纯 md 文本，粘进撰写窗口就是排好版的正文。

TinyMCE 官方的 `markdown` 插件只有付费订阅才有（GPL 包里既没有目录，`tinymce.min.js` 里
`markdown` 字样出现 0 次）。它干的事只有三件：判断是不是纯 md、转成 HTML、压一层 undo；
前两件在 `compose/markdown.js`（纯函数，node 可直接断言），第三件交给 TinyMCE 自己的 paste 流程。

### 三个条件同时成立才转

1. 是**外部粘贴**（`ev.internal` 为假：编辑器内拖字、内部复制不转）
2. 剪贴板里**没有真正的 text/html** —— 判断方式是 content 里除 `p`/`div`/`br` 之外没有别的标签
   （`span` 一出现就说明来源带样式，直接放行）
3. `looksLikeMarkdown()` 打分过线：结构类信号按**行数**累计（标题 ×2、围栏 ×3、表格 ×3、列表项 +1、引用 +1），
   总分 ≥3 过线，或 ≥2 再配一个行内信号（粗体/行内代码/链接）。单独的 `--------` 分隔线过不了。

### 转成什么

| Markdown | 结果 |
|---|---|
| `#` ~ `######` | `<h1>` ~ `<h6>` |
| 三反引号 / `~~~` 围栏代码 | `<pre><code>` + 等宽字体 + 浅灰底，内部不再解析标记 |
| `- ` / `1. ` | `<ul>` / `<ol>`，缩进即嵌套；`- [ ]` 变 ☐ / ☑（邮件里不能用 `<input>`） |
| GFM 表格 | `<table>`：单元格边框、表头底色、`:-:` 对齐全部 inline |
| `> ` | `<blockquote>` |
| `**b**` `*i*` `~~s~~` `` `c` `` | `<strong>` `<em>` `<span style="text-decoration:line-through">` `<code>` |
| `[名](url)` `![图](url)` | `<a>` / `<img>`，只放行 http(s) / mailto / cid / 锚点 / 相对与裸域名；`javascript:`、`data:` 拒绝 |

样式全写 inline：收件端大多不认 `<style>`。表格边框用的是 `content_style` 里那组值
（`1px #c9c9c9` / `padding 4px 8px`），所以粘进来的表格与手动插的一样。

不支持：setext 标题（`===` / `---` 下划线式，与水平线有歧义）、脚注、定义列表、引用式链接、
正文里的 HTML 块（一律当文本转义，`<script>` 不会直通）。

### 关掉与撤销

```js
await browser.storage.local.set({ composeStudio.config: { markdownPaste: false } });
```

关掉后 `PastePreProcess` 根本不注册，粘贴走 TinyMCE 原生路径。判错时 `Ctrl+Z` 一次退回粘贴之前。

---

## 9. 资源全在扩展包内

`base_url` / `skin_url` / `language_url` 都从 `runtime.getURL('vendor/tinymce')` 派生，
`content_css: false`，皮肤 CSS 里的 `url()` 全是 `data:` 内联图。插件数据库（含 192 KB 的 emoji）
也由 `base_url` 派生，走改写过的 `ScriptLoader`（`fetch` + 间接 `eval`）。

**唯一默认为远端的选项是 `emoticons_images_url`**：TinyMCE 7.9 的默认值指向 cdnjs 的 twemoji，
数据库里 `char` 是 `<img>` 时面板每格都会拉图，断网即空白。这里钉成空串，永远用字符渲染。

守住这条的是一层静态检查：

- `tools/check-static.mjs` 第 6 节：我方文件（manifest / background / compose / options）的非注释行里
  不得出现 `http(s)://`（只放行 manifest 的 `homepage_url` / `developer.url` 展示字段）；
  同时断言 `base_url` / `skin_url` / `language_url` 从 `BASE` 派生、`content_css` 为 `false`、
  `emoticons_images_url` 为空串。

把外网 DNS 全部毒化（`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`）后，
工具栏、表情面板、源码对话框仍应正常工作。

---

## 10. 三条实现约束

这三条都是「改动了就会静默坏掉」的地方，改代码前先看：

1. **quirks mode 补丁必须在 `eval(tinymce.min.js)` 之前。**
   撰写窗口的正文文档来自 `about:blank`，没有 doctype，`document.compatMode` 是 `BackCompat`。
   TinyMCE 7 的 inline 模式在这种文档里初始化会静默卡死：`init` 事件永不触发、界面上只剩
   「加载中」、控制台一条报错都没有。文档已解析完、改不了 doctype，只能在被读之前把
   `compatMode` 伪造成 `CSS1Compat`。
2. **`#tcs-toolbar` 不能 `overflow: hidden`。**
   TinyMCE 把弹出层 sink 挂在工具栏内部，菜单顶边对齐按钮底边，工具栏本身只有 38~39px 高；
   一裁切，整块菜单落在盒外，表现是「点了菜单没反应」，而 `getComputedStyle().visibility`
   仍然是 `visible`。层级由 `.tox-tinymce-aux` 的 `z-index: 2147483000` 负责，不需要工具栏参与裁切。
3. **`FormatBlock` 只认裸标签名。**
   `execCommand('FormatBlock', false, '<h1>')` 这种带尖括号的老写法在 7.9.3 里是静默无效的
   （不报错、也不发生任何事），必须传 `'h1'` / `'div'`。

---

## 11. 多语言

八种界面语言：`en`（母版）、`zh_CN`、`zh_TW`、`ja`、`de`、`fr`、`es`、`ru`（每种 165 条文案）。
选项页可以手动指定，默认跟随 Thunderbird。

一份 `_locales/<code>/messages.json` 同时喂给三处：manifest 的 `__MSG_*__` 替换、
选项页与撰写窗口的 `fetch` 读取、`tools/check-i18n.mjs` 的校验。

撰写窗口没用 `browser.i18n.getMessage`，因为它只认浏览器语言 —— 用户手动指定语言时它无能为力。

**加一门语言要动四处**，`check-i18n` 会盯着：

1. `_locales/<code>/messages.json`（照 `en` 的键抄，`$1` 占位符不能丢）
2. `compose/config.js` 的 `LANGUAGES`
3. `compose/i18n.js` 的 `SUPPORTED`
4. `compose/inject.js` 的 `TM_LANG`（TinyMCE 的语言代码与目录名不总一致，法语是 `fr_FR`），
   再由 `npm install` 重新提取 `vendor/tinymce/langs/<code>.js`

`npm run check:i18n` 校验键集合、空文案、占位符、代码引用的键，以及上面四处清单是否互相对得上。

---

## 12. 目录与构建

```
── 包内（项目根就是包根）──────────────────────────────────────────
manifest.json          扩展声明（compose + storage、composeScripts、options_ui）
background.js          注册 compose script / 维护端口与缓存 / 发送前写回正文
compose/
  config.js            配置单一来源：默认值、按钮白名单、校验（撰写窗口与选项页共用）
  i18n.js              语言归一 + 读 _locales 文案
  inject.js            搭壳、加载 TinyMCE、菜单、工具栏、序列化
  markdown.js          md → HTML 解析器 + 「像不像 md」检测器
  shell.css            外壳样式：单行工具栏、直角、弹出层层级、选色器兜底
options/               选项页（工具栏可视化编辑、段落格式、开关、界面语言、诊断日志）
icons/                 icon-48/96/128.png + icon.svg
_locales/              8 种语言 × 165 条文案
vendor/tinymce/        上游静态资源（生成物，npm install 后出现）

── 也在根上，但不进包 ────────────────────────────────────────────
package.json           唯一入口与依赖声明（postinstall / check / test / xpi / build / release）
package-lock.json      依赖的精确版本 + 完整性摘要，以及项目自身的 version
node_modules/          依赖，装完保留
tools/
  extract-tinymce.mjs    提取（也是清单的定义处）：要哪些文件、各自从 node_modules 哪里来
  list-tinymce-files.mjs 只读视图：打印上面那份清单
  check-static.mjs       静态校验 11 节（插件、按钮、命令名、图标名、零外链、装配顺序、
                         发布形态、版本号、直角、许可）
  check-i18n.mjs         文案一致性（键集合、占位符、代码引用键、语言清单）
  test-markdown.mjs      解析器断言（32 条）
  test-config.mjs        配置校验断言（31 条）
  test-i18n.mjs          语言归一与回退链断言（19 条）
  build-xpi.mjs          打 xpi：按顶层白名单读项目根 → dist/<name>.xpi（手写 zip）
.github/workflows/     ci.yml（推送 / PR）、release.yml（标签即发布）
README.md PUBLISHING.md LICENSE

── 产物（gitignore）────────────────────────────────────────────
dist/*.xpi             打包结果
vendor/                第三方静态资源，postinstall 生成
.harness/              本地手工回归页，不进仓库
```

工具链全在 node 上，零第三方运行时依赖：`npm run check`、`npm run build`。

### 项目根就是包根

手写的东西和能装的东西是同一批文件，中间没有装配树。好处是 `runtime.getURL('compose')` 那套
「按包根解析」的运行时契约在仓库里直接成立，临时加载也直接选仓库根。

代价是根目录同时住着 `tools/`、`node_modules/`、`dist/`、文档这些**不进包**的东西，所以
「哪些进包」用显式白名单：`tools/build-xpi.mjs` 的 `PACKAGE_ENTRIES`
（`manifest.json` / `background.js` / `compose` / `options` / `icons` / `_locales` / `vendor`）。
写白名单而不是排除法——漏加一项的后果是包里缺文件（`check-static` 会先报出来），
排除法写错的后果是把 `node_modules` 打进包里。脚本还有第二道闸：收集完若出现
`node_modules/` `dist/` `tools/` `.git` 的路径就直接失败。

### TinyMCE 是构建期依赖

`devDependencies` 里的 `tinymce@7.9.3` 与 `tinymce-i18n@26.9.28`（精确版本，完整性写在
`package-lock.json`）。`npm install` 后由 **postinstall**（`tools/extract-tinymce.mjs`）按白名单
把用到的部分提取到 `vendor/tinymce/`，包内路径就是 `vendor/tinymce/…`。
同一份 `devDependencies` 里还有发版用的 `bumpp`，只被 `npm run release` 调用，不进包。

白名单的**唯一来源是 `compose/inject.js`**：`plugins:` 决定要哪些插件，`TM_LANG` 决定要哪些语言文件。
改完这两处，重新 `npm install` 即可（`extract-tinymce.mjs` 每次整棵重建 `vendor/tinymce`）。
实际入包：silver 主题、dom 模型、default 图标、oxide 皮肤、15 个插件（`tcs_fp` 是自己注册的，
不占上游文件）与 7 个语言包，约 1.9 MB。

`node_modules` 保留：改完插件清单直接 `npm install` 就能重新提取，也随时能对着
`node_modules/tinymce` 复查裁掉了什么。它不进版本库，且约定只有 `extract-tinymce.mjs` 读它；
版本错位由 `check-static.mjs` 第 11 节对账（vendor 里 bundle 的版本注释 vs `package.json`）。

代价：`git clone` 之后不能直接 `npm run build`，要先 `npm install`（`vendor/` 是生成物）。
**别 `rm -rf vendor`** —— 恢复方式是再 `npm install`。

### 可复现构建

`build-xpi.mjs` 把 zip 内时间戳固定成 2020-01-01 12:00、文件顺序排序，同样内容连打两次字节一致。
想确认某个 xpi 是不是本地改过，比一下 md5 或 sha256 就知道。打完会用 `unzip -t` 让独立实现复核
CRC（没装 `unzip` 则跳过，不把它变成依赖）。

### npm scripts

| 命令 | 做什么 |
|---|---|
| `npm install` | 装依赖 → postinstall 提取 TinyMCE → `vendor/tinymce/` |
| `npm run check` | `check:i18n` → `check:static` → `test`（共 82 条断言） |
| `npm run xpi` | 打包到 `dist/better-compose-<version>.xpi` |
| `npm run build` | `check` → `xpi` |
| `npm run release` | `bumpp`：改四处版本号 → `check` → 提交 → 打标签（不推送，见 PUBLISHING 第六节） |

CI 与 Release 跑的是同一条命令，不存在「CI 能过、本地过不了」的分叉。

### 版本号只有一个来源

`package.json` 的 `version` 是版本号的来源，`npm run release`（bumpp）负责把它同步到
`package-lock.json`、`manifest.json` 与 `compose/markdown.js` 的 `VERSION`，然后跑
`npm run check` 当门禁、提交 `chore: release v<version>` 并打 `v<version>` 标签。
四处任意一处对不上，`check-static.mjs` 第 9 节会当场报出来。

---

## 13. 安装

**临时加载（调试用）**

1. `npm install`
2. Thunderbird → 工具 → 开发者工具 → 调试附加组件 → 此 Thunderbird
3. 「临时载入附加组件」→ 选**项目根目录里的 `manifest.json`**

改完代码在调试器里点「重新载入」；改过插件/语言清单要先 `npm install` 重新提取。
临时加载在 Thunderbird 重启后失效。

**打包安装**

```bash
npm install
npm run build     # → dist/better-compose-<version>.xpi
```

然后：工具 → 附加组件和主题 → 齿轮 → 从文件安装附加组件。

---

## 14. 选项页

工具 → 附加组件和主题 → BetterCompose → 「设置」，或 `about:addons` 里点齿轮选设置。

配置页**内嵌在附加组件页里**（`options_ui.open_in_tab: false`），不跳新标签页。
版式按内嵌场景做：宽度按 600px 上下设计（窄到 620px 时标签与下拉上下叠），操作区 `position: sticky` 贴底。

| 按钮 | 行为 |
|---|---|
| 保存（Ctrl/⌘+S） | 写入 storage；没有改动时是灰的 |
| 取消 | 丢掉表单上的改动，回到 storage 里那一份；有改动时先弹确认框 |
| 恢复默认 | 确认后把全部设置写回默认值（立即生效） |

**未保存的改动**不用手工维护的 dirty 标志，而是拿「当前表单 normalize 出来的 patch」与
「已落盘的那份」比（`CC.diff` 的键序固定，比序列化字符串就够）。任何一条改动路径——加按钮、
拖顺序、改段落格式、换语言——都会立刻把状态改成「有未保存的改动」并点亮保存/取消。
`beforeunload` 只是兜底，内嵌在宿主页里时浏览器不保证弹窗。

| 配置项 | 作用 | 默认 |
|---|---|---|
| 工具栏 | 按钮与顺序，`\|` 表示分组。可视化编辑：加、删、左右移动 | 18 个按钮，见第 1 节 |
| 段落格式 | 一行一个 `名称=标签`，标签限 `p div h1–h6 pre blockquote` | 正文文本=div、段落=p、标题 1–6、预格式化 |
| 新段落默认格式 | 空邮件第一段用哪个标签 | `div`（=「正文文本」） |
| Markdown 粘贴 | 纯 md 文本粘进来时转富文本 | 开 |
| 界面语言 | 本页 + 编辑器 UI 一起换；默认跟随 Thunderbird | 自动 |
| 诊断日志 | 把 `[BetterCompose] …` 打到控制台 | 关 |

两个设计选择：

- **只保存与默认值不同的键**（`CC.diff`）。段落格式的默认名字跟着界面语言翻，全量保存会把
  当时那门语言的名字冻进 storage；「一个键都没改」时存的是 `{}`，等于清空覆盖。
- **配置只有一个实现**：`compose/config.js`。选项页不自己写一套校验——两套的下场是
  「选项页说没问题、编辑器里按钮却没了」。

改完**新开**一个撰写窗口才生效（配置只在 init 时读一次，已开的窗口不会热替换）。

---

## 15. 验证清单

装完新开一封 HTML 邮件（纯文本模式会被主动让位）。

1. **工具栏**：一行 18 个按钮，顺序如第 1 节。窗口拉宽时全在；变窄时尾部收进「更多」，但**不折行**。
2. **回复一封邮件**：正文区正常出现，引用原文也在编辑器里、能编辑。若看到「加载中」不动、
   或工具栏在而正文空白，就是第 6 节的时序问题。
3. **菜单**：点「菜单」→ 撤销/重做、剪贴板/格式/插入/表格/视图五组、查找替换都在；
   点「格式 → 文字颜色 → 红」，选中文字立刻变红。**菜单只露一条就是又被裁切了。**
4. **字体 / 字号**：选中一段 → 宋体、18pt，正文变样且**两个按钮上的文字跟着变**；
   光标移回默认段落，回到「系统默认」「10.5pt」。
5. **颜色**：点「字体颜色」右侧箭头 → 22 格色板（浅底/标准/深底/灰阶/黑白五行），选「红」立刻变红；
   「背景颜色」→ 黄，出现黄底。主键（图标）点一下套用上次用过的颜色。
   色板最下「自定义颜色」→ 选色器左侧面板**必须有颜色**，拖色相条时底色要跟着变。
6. **对齐**：光标放进一段点「居中」，段落居中且居中按钮亮着（左对齐同时灭掉）。
7. **列表样式**：无序的箭头有 预设 / 实心圆 / 空心圆 / 实心方块；有序是 预设 / a. / i. / A. / I.。
8. **表情**：点笑脸 → 「表情符号」面板九个分类 + 搜索；插入的是字符，发送后收件端正常显示。
   首次打开闪一下 `Loading emojis...` 是 192 KB 数据库在加载。
9. **断网**：拔网线再写一封信，工具栏、表情面板、源码对话框照常可用。
10. **源码**：`<>` 打开「源代码」对话框，改一处点保存正文立即变；菜单 → 视图 → HTML 源码… 是同一入口。
11. **格式刷**：选带格式的字 → 点格式刷（按钮变亮）→ 选中另一段松开即套用 → 再选第三段继续刷
    → `Esc` 退出。
12. **图片**：插入 → 图片 → 上传，选一张本地图。
13. **确认是 inline**：控制台 `document.querySelectorAll('iframe').length` 应为 `0`。
14. **存草稿**：写点东西按 `Ctrl+S`，再打开那封草稿看源码。正文里应该**只有你写的内容**——
    没有 `tox-` 开头的 class、没有工具栏的 SVG、没有 `.tox-tinymce-aux`。
    若又出现，先看控制台有没有「工具栏搬进 shadow 失败」（该环境不吃 `attachShadow`，
    脚本会自动退回，功能正常、草稿会脏）。
15. **段落格式**：新开窗口，TB 自带的格式下拉应显示**「正文文本」**；敲两行回车，行距正常、
    没有一大截空白；在源码对话框里应是 `<div>` 而不是每行一个 `<p>`。
    菜单 → 格式 → 段落格式：当前档位带勾，选「标题 2」应立刻变大变粗，再选「正文文本」还原。
16. **配置切换**（改完 storage 后新开窗口）：
    `browser.storage.local.set({ 'composeStudio.config': { toolbar: 'undo redo | tcs_block | code' } })`
    → 新窗口只剩三个按钮；把 `toolbar` 写成 `'nope nope2'` → 回到默认 18 个，控制台列出被忽略的名字。
17. **Markdown 粘贴**：把下面这段当**纯文本**复制（别用富文本来源），粘进正文：

    ```
    ## 报价说明

    - 第一批：下周一到货
    - 第二批：~~待定~~ 改为 10 月 30 日
    - 附件：quote-2026.xlsx

    | 型号 | 单价 |
    |:--|--:|
    | A-100 | ¥35 |
    ```

    应一次变成：`h2` 标题 + 三项列表（第二项带删除线）+ 带边框表格（单价列右对齐）。
    再粘一段普通文字，必须原样进来；粘错了按一次 `Ctrl+Z` 退回粘贴之前。

确认图片真的走了 TB 通路，发送前在撰写窗口控制台跑：

```js
window.__tcs.info()
// { version: '7.9.3', images: [{ src: 'data:image/png;base64,…', dns: 'false' }] }
```

`dns: "false"` 就是「作为 MIME 部件发出」。把信发给自己，收件箱源码里应出现
`Content-Type: multipart/related` 与 `Content-ID: <…>`，正文里是 `cid:…`。

---

## 16. 已知限制

- **撰写窗口内没有自动化测试**。静态校验与三个 node 单测覆盖的是配置、Markdown 解析、文案一致性，
  以及「按钮/命令/图标在 bundle 里真的存在」；编辑器的实际行为（布局、菜单命中、选色器、
  与 TB 的时序）只能在真实 Thunderbird 里按第 15 节手工过一遍。
  首次使用请先拿草稿试，尤其拿一封真实邮件点一次「回复」，别直接发重要邮件。
- TinyMCE 的皮肤 CSS 由它自己以 `<link>` 注入。若撰写窗口的 CSP 拦掉 `moz-extension:` 样式表，
  界面会退化成无皮肤（功能仍在）。
- 格式刷只覆盖字符级格式，且只复制**显式写在元素上**的样式。
- 正文里的 `data:` 预览图在编辑器里始终存在，只有发送时才由 TB 转换，所以草稿文件偏大是正常的。
- **配置只在 init 时读一次**，改完必须新开一个撰写窗口才生效（热更新意味着重建编辑器、丢掉正文）。
- `defaultBlockFormat` 改成 `div` 以外的值会**改变存进草稿的 HTML**，收件端渲染、引用缩进、
  邮件模板样式都可能跟着变。
- 工具栏的滑动阈值与系统字体、按钮组合有关，不是固定像素值。

## 回滚

停用或卸载扩展即可。不动 Thunderbird 安装目录，也不写任何配置文件。

## 发布

见 [PUBLISHING.md](PUBLISHING.md)：打包、上传 ATN、审核常见问题的回答。
