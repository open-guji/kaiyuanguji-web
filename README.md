# 开源古籍 (Kaiyuan Guji) 官网

> 让科技赋予古籍数字生命 — https://www.kaiyuanguji.com

本仓库是开源古籍项目官网的源码。Next.js 16（App Router）全栈部署在腾讯云 EdgeOne Pages：静态页 + `/item/<id>` 云函数服务端渲染 + 边缘函数；
索引数据不在站点里，由 CI 打包后走独立 CDN `data.kaiyuanguji.com`（新加坡 COS）；
搜索走 Meilisearch（L1，上海）+ 浏览器内 MiniSearch 分片（L2 兜底）。

**想弄清整体是怎么设计的**：[docs/architecture.html](docs/architecture.html)（自包含网页，下载后用浏览器打开；页面、数据、缓存、搜索、发布回滚、测试监控、SEO 都在里面）。出问题先看 [docs/runbook.md](docs/runbook.md)。

**新接手的人先读交接手册**：[开源古籍网站交接手册](https://claude.ai/code/artifact/0b4a9456-eaf9-4f4c-9e2d-72bba9f4e5c8)
（源文件在 overview 仓 `项目进展/古籍索引网站/2026-09-网站交接手册.html`）。本 README 只给最短路径。

## 仓库结构

| 目录 | 作用 |
|---|---|
| `nextjs/` | 网站本体 |
| `e2e/` | **打线上站点**的验收测试（Playwright），部署后 CI 自动跑；本地 `TARGET=http://localhost:3000` |
| `perf/` | 性能基准与旧 smoke（Playwright + CDP） |
| `indexer/` | 跑在上海服务器上的 Meilisearch 索引器（`full-reindex.mjs`、`reindex-limited.sh`），**不在 CI 里跑** |
| `edge-functions/` | EdgeOne Pages 边缘函数：`api/feedback.js`（用户反馈）、`api/track-error.js`（前端错误自收） |
| `ops/` | 全栈构建包装、清缓存、回滚计划、数据巡检、服务器救援等脚本 |
| `.github/workflows/` | `deploy.yml`（部署）· `test.yml`（PR/夜间）· `rollback.yml`（回滚）· `monitor.yml`（监控私有半边）· `dq.yml`（数据巡检）· `screenshots.yml`（整站截图）· `e2e-remote.yml`（对线上站跑 e2e）· `cutover-check.yml`· `edgeone-env-sync.yml`· `edgeone-purge-urls.yml` |

索引页的 React 组件**不在本仓**，在 npm 包 `book-index-ui`（源码 `open-guji/book-index-manager` 的 `ui/`）。
本仓 `nextjs/src/app/book-index/page.tsx` 只做数据源与搜索的装配。

## 本地开发

```bash
git clone https://github.com/open-guji/kaiyuanguji-web && cd kaiyuanguji-web
npm install                     # 仓库根：装 husky pre-push 钩子（push 前跑单测）
cd nextjs && npm install

# A. 不需要任何数据仓，读 GitHub raw（首次加载慢）
rm -f .env.local && npm run dev

# B. 读本地 D:\workspace 下的 book-index / book-text（推荐）
bash scripts/setup-local.sh     # 写好 .env.local：NEXT_PUBLIC_MODE=local + BOOK_INDEX_WORKSPACE_ROOT
npm run dev                     # http://localhost:3000/book-index
```

Windows 上旧的 `next dev` 没退干净时新实例会悄悄改用 3001/3002，以 `Local:` 提示为准；卡住就 `rm -rf .next`。

改 `book-index-ui` 组件后想在本站看效果：在 `book-index-manager/ui` 里 `npm run build:lib`，
把 `dist/*` 拷进 `nextjs/node_modules/book-index-ui/dist/`，删 `.next` 重启 dev。没有 npm link。

## 测试

```bash
cd nextjs && npm test                                   # Jest 单测；pre-push 钩子与 CI 都跑它
TARGET=http://localhost:3000 npm --prefix e2e run test:ui  # e2e 打本地站；不带 TARGET 默认打线上
NEXT_PUBLIC_MODE= NEXT_PUBLIC_DATA_SOURCE=bundle npm run build   # 验证生产那种静态 build
```

写 e2e 前读 [`e2e/README.md`](e2e/README.md)：断言新版 UI 行为的用例必须加 `requireUiVersion` 版本门禁，否则发布顺序一错就红。

## 部署

**push 到 `main` 先发测试站**（`staging.kaiyuanguji.com`），`deploy.yml` 全自动：单测 → 克隆三个数据仓 → `bundle-data.mjs` 打包 →
写数据桶（测试站用 `staging/` 前缀）→ 全栈构建 → 部署 kyg-staging → 清缓存 → 部署后 e2e（verify）。
**正式站只由 promote 上**：Actions 里手动触发 `target=production`，`promote` 选 `code`（默认，只发代码，必须填 `from_run`，数据不动）、`code+data`（代码与数据一起，数据上线需要用户确认）或 `data`；构建用测试站记下的 commit，部署到 kyg-ssr-spike（www）。
push 到 main 验过后自动晋升（`auto-promote-code`）只发代码（`promote=code`），不会带数据。
出问题用 Actions 里的 Rollback。细节见 [docs/architecture.html](docs/architecture.html) 第八节和 [docs/runbook.md](docs/runbook.md)。

- **发布顺序**：先 `npm publish` UI 包 → 再把依赖 bump 与 e2e 改动**同一批**推 main。反了 verify 必红。
- **只发数据**：数据仓 push 后不会立即触发；等每天北京 04:30 定时，或 `gh workflow run deploy.yml`。测试站 verify 绿之后自动 `promote=data` 到正式站。
- **发布后验证**：`curl -s "https://data.kaiyuanguji.com/latest.json?cb=$RANDOM$RANDOM"` 看 commit（必须带随机串，EdgeOne 会给旧副本）；线上是哪一版看 `/api/version`。
- 完整流程与 Secrets 清单见 overview 仓「项目进展/古籍索引网站/网站交接手册.html」。

## 数据源模式

`NEXT_PUBLIC_DATA_SOURCE`：`cos`（生产）· `bundle`（CI 缺 COS 凭证时的降级）· `local`（dev 读本地仓）· `github`（dev 无本地仓）。
`NEXT_PUBLIC_MODE=local` 会关闭静态导出并打包 `*.local.ts` API route，CI 里显式置空。环境变量清单见 `nextjs/.env.example`。

## 更多

- 路线图与各板块说明：站内 [/roadmap](https://www.kaiyuanguji.com/roadmap)、[/typesetting](https://www.kaiyuanguji.com/typesetting)、[/extraction](https://www.kaiyuanguji.com/extraction)、[/toolkit](https://www.kaiyuanguji.com/toolkit)、[/storage](https://www.kaiyuanguji.com/storage)、[/intelligence](https://www.kaiyuanguji.com/intelligence)
- 项目组：https://github.com/open-guji · 问题反馈：[issues](https://github.com/open-guji/kaiyuanguji-web/issues)
