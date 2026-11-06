# 网站与 book-index-ui 的分工

A41，2026-11-06 定稿（sheldon 同意）。完整论证与迁移记录在项目共享目录 `a41-ui-boundary/`（评估、长期方案与迁移计划、并行分工、收尾清单）；本页只留以后改代码要遵守的部分。

## 划界原则

**只靠公开数据格式（guji-format、book-text、book-index）就能工作的，归 `book-index-ui`；依赖本站基础设施或业务流程的，归网站。**

问三个问题：
1. 换一个宿主（VS Code 扩展、别人的镜像站），它是否还应该一模一样？是 → 包。
2. 它是否写了本站的域名、桶、后端接口或某一本书的 id？是 → 网站（或者改成数据）。
3. 它是否需要知道包的 DOM 结构？是 → 说明包的接口缺了一块，补接口，**不要在网站里抓 DOM**。

| 归包 | 归网站 |
|---|---|
| 数据格式的读取与语义（manifest、章、对读文件、版本列表规则） | 传输层：数据 CDN 地址、缓存、首屏种子 |
| 所有页面渲染与交互（详情、目录、阅读器、搜索结果） | 路由、URL、SSR、SEO |
| 阅读器插件接口，及只依赖公开数据的通用插件 | 业务插件：下载、报错与改字、校对邀请、字体补齐、全文定位 |
| 设计 token 与默认主题 | 品牌色、字体托管、站点外壳 |

## 阅读页功能 = 阅读器插件

阅读页的每个站内功能都是一个 `ReaderPlugin`（`nextjs/src/app/read/[id]/plugins/`），经 `<TextReader plugins={[…]}>` 传入。插件能用的接口（类型从 `book-index-ui` 根导出，说明见包内 `ui/README.md` 与 `ui/src/components/Reader/plugins.ts`）：

- `onChapter(ctx)`：换章时取自己的数据；
- `settings` / `toolbar` / `overlay`：阅读设置里的分组、工具条位、浮层，窄屏由包收进抽屉；
- `decorate(api)`：按格位给字加颜色、下划线、下标、插入字（对读版面与书影画布都生效）；
- `onCell.click/hover`、`selectionActions`：格子事件和选字浮条按钮；
- `api.locate / scrollTo / rectOf / cells`：定位与滚动，不暴露 DOM。

新功能照这个写。现有范例：下载（download-plugin）、校勘层、报错与改字（report-plugin）、全文定位（fulltext-plugin）、版本号芯片、补字体，以及对校（`lib/compare/`）。

## 防回退的检查

- `src/__tests__/no-reader-dom.test.ts`：`src` 里出现 `data-char-id`、`data-ft-cp`、`data-reader-lead` 就红。
- `src/__tests__/no-bim-selectors.test.ts`：出现 `.bim-*` 结构选择器就红（例外清单为空）。
- 样式只改品牌相关变量，其余走包的 token（包的 `ui/README.md`「样式契约」列出对外承诺的 token）。

## 分支与发版

见 [开发流程.md](开发流程.md)：PR 投 `dev`；包在 dev 上发预发布；发版切 `rc/vX.Y.Z`，merge commit 并入 main；正式站由 Deploy 手动晋升。
