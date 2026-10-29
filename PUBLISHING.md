# 发布到 addons.thunderbird.net（ATN）

这份文档只讲「从仓库到上架」。功能与实现见 [README](README.md)。

---

## 一、定下之后不要改的事

| 项 | 值 | 为什么不能改 |
|---|---|---|
| 扩展 ID | `better-compose@edwinhuish.github.io` | 上传 ATN 后永久固定。改 id 等于发布一个新扩展，老用户升不上来 |
| 包内名称 | `__MSG_app_name__` | 八种语言各自显示自己的名字 |
| 许可证 | MIT | 已在包里，ATN 上选同一个 |

---

## 二、打包

```bash
npm install     # 装依赖 → postinstall 把 TinyMCE 提取到 vendor/tinymce/
npm run build
# → dist/better-compose-1.0.0.xpi
```

`npm run build` 是 `check → xpi` 两段的串：

| 步骤 | 命令 | 做什么 |
|---|---|---|
| 0 | `npm install` 的 `postinstall` | 按清单把 TinyMCE 提取到 `vendor/tinymce/`（`node_modules` 保留） |
| 1 | `npm run check` | `check-i18n.mjs` → `check-static.mjs` → 三个单测（共 82 条断言） |
| 2 | `npm run xpi` | 按顶层白名单直接读项目根，打成 zip（手写 zip，只用 node 内置 zlib）→ `unzip -t` 复核 |

构建入口只有 npm scripts，没有 `build.sh`：同一份流水线写两遍，改一处忘另一处就会出现
「`npm run check` 绿、`./build.sh` 红」。三个平台都用同一条 `npm run build`，Windows 上不需要 Git Bash。
（命令叫 `xpi` 而不是 `pack`，是因为 `npm pack` 是 npm 自带命令。）

打包是**可复现**的：zip 内时间戳固定成 2020-01-01 12:00、文件顺序排序，同样内容连打两次字节一致。
所以「这个 xpi 是不是我本地改过」比一下 md5 或 sha256 就知道。

**项目根就是包根**：`manifest.json`、`background.js`、`compose/`、`options/`、`icons/`、`_locales/`
都摆在根上，`vendor/tinymce/` 由 postinstall 铺好。打包不需要任何拷贝或路径映射，只按
`PACKAGE_ENTRIES`（`tools/build-xpi.mjs`）挑顶层项压 zip。

代价是根目录同时住着 `tools/`、`node_modules/`、`dist/`、文档这些不进包的东西，所以「哪些进包」
写成显式白名单而不是排除法：漏加一项的后果是包里缺文件（`check-static` 会先报出来），
排除法写错的后果是把 `node_modules` 打进包里。脚本另有第二道保险：收集完若出现
`node_modules/` `dist/` `tools/` `.git` 的路径就直接失败。

好处是「包里到底是什么」本地 `ls` 就能看见，而且**能直接把仓库根当目录临时载入**（调试时不用先打包）。

进包的是 7 项：`manifest.json` `background.js` `compose/` `options/` `icons/` `_locales/` `vendor/`。
`tools/`、`node_modules/`、`dist/`、`.harness/`、`*.md` 都不进包。唯一的 `.md` 是
`vendor/tinymce/license.md`（GPL 要求随包分发，它以显式条目出现在提取清单 `CORE` 里）。

### TinyMCE 从哪来

TinyMCE 不在版本库里，也不是手写源码，而是 `devDependencies` 里的 `tinymce@7.9.3` +
`tinymce-i18n@26.9.28`（精确版本 + 锁文件里的完整性摘要），由 `tools/extract-tinymce.mjs`
（`postinstall`）按 `compose/inject.js` 的 `plugins` / `TM_LANG` 提取子集到 `vendor/tinymce/`。

因此发布机必须能访问 npm registry，且**不能加 `--ignore-scripts`**：否则 postinstall 不跑，
`vendor/` 是空的，`npm run build` 会在打包阶段直接报错。

`node_modules` 保留：改完插件/语言清单重新 `npm install` 就能再提取，也能随时对着
`node_modules/tinymce` 复查裁掉了什么。约定只有 `extract-tinymce.mjs` 读它，每次 postinstall
都整棵重建 `vendor/tinymce`，版本错位由 `check-static.mjs` 第 11 节对账。

---

## 三、上传前自查

```bash
npm run check        # 下面三项一次跑完，与 CI、与发布工作流是同一条命令
npm run check:i18n   # 八种语言的键集合、占位符、语言清单四处对齐
npm run check:static # 静态校验 11 节：插件、按钮、命令名、图标名、零外链、装配顺序、
                     # 发布形态、版本号、工具栏直角、TinyMCE 版本与许可
npm test             # 32 + 31 + 19 = 82 条断言
```

再手动过一遍（这几件事静态检查抓不到）：

1. 装 xpi → 新开撰写窗口 → 工具栏出来、正文能打字、中文输入法正常
2. `about:addons` → BetterCompose → **设置** → 配置**在当前这一页里展开**（不跳新标签页），
   没有大标题、按钮贴在底部看得见
3. 改一项（比如取消勾选 Markdown）→ 底部出现「有未保存的改动」、「保存」「取消」变亮 →
   点「取消」→ 弹确认框 → 确定后改动回滚、按钮变灰
4. 再改一项后点「保存」→ 出现「已保存」，重开撰写窗口生效；点「恢复默认」→ 确认后回默认值
5. 选项页里把界面语言切到 English，整页立刻变英文，撰写窗口也是

功能层面的完整清单见 README 第 15 节。

---

## 四、代码之外要准备的材料

ATN 开发者中心（<https://addons.thunderbird.net/developers/>）上架时要填/传这些：

- **图标**：`icons/icon-48.png` / `icon-96.png` / `icon-128.png` 已在仓库里，manifest 的 `icons`
  指向这三张（PNG 比 SVG 稳）。ATN 列表页那张图是**另外上传**的，用同一个 `icon-128.png` 即可；
  要改设计就改 `icons/icon.svg`，再导出三种尺寸：

  ```bash
  cd icons && for s in 48 96 128; do magick -background none icon.svg -resize ${s}x${s} icon-${s}.png; done
  ```
- **截图** 2–4 张：撰写窗口的单行工具栏、左侧折叠菜单展开、选项页、暗色主题下的样子。
- **简介**：一句短描述 + 一段长描述，英文与中文各一份（`_locales` 里的 `app_description` 可直接用）。
- **分类**：Composition。
- **支持方式**：GitHub Issues 或邮箱。
- **隐私政策**：不需要单独写 —— 本扩展不联网、不收集任何数据、不发遥测。
  如果表单要求填，就写「This add-on does not collect any data.」
- **源码**：不需要额外提交。包内只有自写代码与 npm 原样的 `tinymce@7.9.3` 发行文件。

---

## 五、审核可能会问的三件事

**1. 为什么用 `eval`？**

撰写窗口的 CSP 不允许 `<script src="moz-extension://…">`，所以 TinyMCE 只能 `fetch()` 包内文件
再用 `(0, eval)()` 执行；它内部 `ScriptLoader.loadScript` 也被改成同样的 fetch + eval。

**没有任何远程代码**：所有 URL 都是 `moz-extension://`，且都列在 `web_accessible_resources` 里。
`tools/check-static.mjs` 第 6 节就是干这个的 —— 我方代码里出现任何 `http(s)://`
（manifest 的 `homepage_url` / `developer.url` 展示字段除外）都会让构建失败。

**2. 为什么要 `compose` 与 `storage` 权限？**

`compose` 是必须的：`getComposeDetails`（拿正文与是否纯文本）、`onBeforeSend`（发送前把编辑器内容
写回 TB 的编辑区）、`composeScripts.register`（注入脚本都挂在这上面）。
`storage` 只存一条配置（`composeStudio.config`）。没有 host 权限，不读邮件、不读通讯录。

**3. 包里的压缩 JS 是什么？**

`vendor/tinymce/tinymce.min.js` 与 `vendor/tinymce/**/*.min.js` 是 npm 上 `tinymce@7.9.3` 的
**原样发行文件**（GPL-2.0-or-later），由 `tools/extract-tinymce.mjs` 在 `postinstall` 阶段按白名单
提取，打包时原样入包：没有二次混淆，也没有打补丁；许可文本 `vendor/tinymce/license.md` 随包。
裁剪只是不提取用不到的插件、皮肤与语言包，文件本身一字未改。语言包来自 `tinymce-i18n@26.9.28`
的 `langs7/`，同样原样入包。两个依赖的版本与完整性摘要记在 `package.json` / `package-lock.json`；
`check-static.mjs` 第 11 节还会比对「包内 bundle 的版本注释」与「package.json 声明的版本」，
对不上直接构建失败。

---

## 六、版本与更新

- 版本号语义化，ATN 只接受递增：修 bug 用 `1.0.1`，加功能用 `1.1.0`。
- 版本号统一由 [bumpp](https://github.com/antfu-collective/bumpp) 改，不要手工编辑散落的字面量：

  ```bash
  npm run release
  ```

  `package.json` 里的脚本是：

  ```
  bumpp package.json package-lock.json manifest.json compose/markdown.js \
        --git-check -x "npm run check" --no-push
  ```

  一次改四处：`package.json` 的 `version`（版本号的来源）、`package-lock.json` 的两个
  `version` 字段、`manifest.json` 的 `version`（ATN 与 about:addons 读它）、
  `compose/markdown.js` 的 `VERSION`（纯函数模块拿不到 `browser`，只能写字面量）。

  `--git-check` 要求工作区干净，`-x` 在提交前跑一遍 `npm run check`：版本没对齐、文案缺失、
  出现外链之类的问题会在这里被拦下，不会带着坏状态打出标签。bumpp 随后提交
  `chore: release v<version>` 并打 `v<version>` 标签。
  脚本带 `--no-push`：**推标签会立刻触发 Release 工作流**，这一步留给人确认。

- 发布步骤：`npm run release` → `git push --follow-tags` → 等 Release 绿 →
  下载同一份 xpi 传 ATN。
- 手工改也仍然能用（改完跑 `npm run check`），漏改一处 `check-static.mjs` 第 9 节会当场报出来——
  这条是兜底，不是常规路径。
- 升级 TinyMCE：改 `package.json` 里 `devDependencies.tinymce` 的精确版本 → `npm install` →
  `npm run build`。语言包（`tinymce-i18n`）版本独立；注意只有 `langs7/` 是给 TinyMCE 7 用的
  （`langs8/` 是 TinyMCE 8，语言代码命名也从 `zh_CN` 变成 `zh-CN`）。插件清单变了的话，
  `check-static.mjs` 第 2 节会报「插件文件缺失」。
- 回滚：ATN 允许重新上传旧版本（版本号不能重复），但用户端不会自动降级。
- 升级时 `browser.storage.local` 里的配置会保留，**新增配置项必须给默认值**——
  老用户的 storage 里不会有这个键。

---

## 七、自动化：CI 与 Release

两个工作流在 `.github/workflows/` 下，各管一件事，跑的命令与本地完全一样
（`npm run check` / `npm run build`）。`package.json` 是唯一的入口定义；第三方依赖只有
构建期的 tinymce / tinymce-i18n 与发布期的 bumpp，版本与完整性由 `package-lock.json` 钉住
（也顺带当 npm 缓存键）。

### CI（`ci.yml`）

- **触发**：push 到 `master`、指向 `master` 的 PR、手动触发。
- **矩阵**：Linux 上 Node 22 / 24 / 26，macOS 与 Windows 各跑一次 Node 26。
  后两个平台要验的只是「`npm run build` 在三个平台上跑不跑得通」，与 Node 小版本无关。
- **步骤**：`npm ci`（postinstall 提取 TinyMCE）→ `npm run check`（82 条断言 + 文案一致性 +
  静态校验）→ `npm run build`（检查 + 打包）→ 在 `ubuntu-latest · Node 24` 上连打两次比字节
  （守住可复现构建）→ 上传 xpi（保留 7 天）。
- **并发与缓存**：PR 连续推送取消上一次（`cancel-in-progress`），`master` 不取消；
  npm 缓存键跟着 `package-lock.json` 走。
- **门禁**：末尾的 `CI 通过` job 汇总矩阵结果，分支保护只勾这一个。
- **密钥**：不需要，`permissions: contents: read`。

### Release（`release.yml`）

- **触发**：推 `v*.*.*` 标签；或手动触发（`tag` 输入留空则用 `v<manifest.version>`，
  标签不存在就在触发时的提交上建）。
- **版本号来源**：唯一来源是 `manifest.json` 的 `version`（`markdown.js` 的 `VERSION` 由
  `check-static.mjs` 强制对齐）。标签必须等于 `v<version>`，不一致在打包前直接失败，
  不会出现「标签 v1.1.0、包内 1.0.0」。
- **步骤**：解析并校验版本（Node 24）→ `npm run build`（标签推送不触发 `ci.yml`，所以检查在这里
  原样再跑一遍）→ 复核可复现并生成 `SHA256SUMS.txt` → `gh api .../releases/generate-notes`
  生成变更列表、补上安装说明 → `gh release create`（已存在则 `upload --clobber` + `edit`，可安全重跑）。
- **产物**：`better-compose-<version>.xpi` + `SHA256SUMS.txt`；校验用 `sha256sum -c SHA256SUMS.txt`。
- **权限与密钥**：`permissions: contents: write`，用自动注入的 `GITHUB_TOKEN`，
  **不需要任何自定义 secret**。job 绑在 `environment: release` 上，建议给它加
  「限定 admin / 必填审批」的保护规则当最后一道闸。
- **不做什么**：不上传 ATN。`web-ext sign` 需要 AMO/ATN 的 `WEB_EXT_API_KEY` 与
  `WEB_EXT_API_SECRET`，且上传后仍要人工填表单 —— 所以保留手动，凭据只留本地。

### 两者的关系

Release **不依赖** CI 的运行结果（不串 `workflow_run`），而是自带同一套检查：
标签推送根本不经过 `master` 分支，跨工作流串联只会让「发布会什么卡住」更难查。
唯一的软约束是「标签应打在 `master` 上」，不在只给 warning 而不是失败 ——
从维护分支发补丁版本是合理需求。

日常发一版：改两处版本号 → 提交 → `git tag v1.0.1 && git push origin v1.0.1` →
等 Release 绿 → 下载 xpi 传 ATN。
