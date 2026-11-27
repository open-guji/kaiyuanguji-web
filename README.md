# 开源古籍 (Kaiyuan Guji) 官网

> 让科技赋予古籍数字生命 — https://www.kaiyuanguji.com

本仓库是开源古籍项目官网的源码。Next.js 16（App Router）全栈部署在腾讯云 EdgeOne Pages：静态页 + `/item/<id>` 云函数服务端渲染 + 边缘函数；
索引数据不在站点里，由 CI 打包后走独立 CDN `data.openguji.com`（新加坡 COS；旧域名 data.kaiyuanguji.com 回源同一个桶，继续可用）；
搜索走上海搜索机（L1：默认 Meilisearch，Postgres 后端 `search-pg/` 已就绪，经 COS 上 `search/switch.json` 切 shadow／pg，用 workflow `search-switch`）+ 浏览器内 MiniSearch 分片（L2 兜底）。
所有域名（站点、数据、搜索 API、测试站……）只写在 [`config/hosts.json`](config/hosts.json)，改完跑 `node ops/sync-hosts.mjs`；不要在代码里写死域名（见 [docs/data-domain-migration.md](docs/data-domain-migration.md)）。

**想弄清整体是怎么设计的**：[docs/architecture.html](docs/architecture.html)（自包含网页，下载后用浏览器打开；页面、数据、缓存、搜索、发布回滚、测试监控、SEO 都在里面）。出问题先看 [docs/runbook.md](docs/runbook.md)。

**链接到某一格、存校对票／改字票**：用字格永久编号 u（`/read/<书>/<册>?u=<n>`），见 [docs/字格永久编号u.md](docs/字格永久编号u.md)。

**新接手的人**：先读本 README 的最短路径，再读 [docs/开发流程.md](docs/开发流程.md)、[docs/ui-boundary.md](docs/ui-boundary.md)。overview 仓已淘汰，旧「交接手册」只作历史参考；项目分工与长期经验在 ai-team 仓 `domain/网站与运维/`。

## 仓库结构

| 目录 | 作用 |
|---|---|
| `nextjs/` | 网站本体 |
| `e2e/` | **打线上站点**的验收测试（Playwright），部署后 CI 自动跑；本地 `TARGET=http://localhost:3000` |
| `perf/` | 性能基准与旧 smoke（Playwright + CDP） |
| `indexer/` | 跑在上海服务器上的 Meilisearch 索引器（`full-reindex.mjs`、`reindex-limited.sh`），**不在 CI 里跑** |
| `edge-functions/` | EdgeOne Pages 边缘函数：用户反馈、精校票、改字意见、讨论、待审单、登录（邀请制＋邮箱登录／注册，见 `docs/membership.md`）、搜索代理等（`api/*`、`oauth/*`）。读者意见类数据 11-22 起存中心库 D1（经 Worker `/v1/web/inbox`），KV 兼容层待退役 |
| `search-pg/` | 搜索的 Postgres 后端（search-api、入库程序、SQL），见其 README |
| `ops/` | 全栈构建包装、清缓存、回滚计划、数据巡检、服务器救援等脚本 |
| `.github/workflows/` | `deploy.yml`（部署）· `test.yml`（PR/夜间）· `rollback.yml`（回滚）· `monitor.yml`（监控私有半边）· `dq.yml`（数据巡检）· `screenshots.yml`（整站截图）· `e2e-remote.yml`（对线上站跑 e2e）· `cutover-check.yml`· `edgeone-env-sync.yml`· `edgeone-purge-urls.yml` |

索引页与阅读器的 React 组件**不在本仓**，在 npm 包 `book-index-ui`（源码 `open-guji/book-index-manager` 的 `ui/`）。
两边怎么分工、阅读页功能怎么写成插件，见 [docs/ui-boundary.md](docs/ui-boundary.md)。
本仓 `nextjs/src/app/book-index/page.tsx` 只做数据源与搜索的装配。

## 本地开发

**最快：看网站 dev ＋ UI 包源码 ＋ 最新数据（不需要数据仓，也不用发测试站）**

```bash
git clone https://github.com/open-guji/kaiyuanguji-web && cd kaiyuanguji-web
npm install                              # 仓库根：装 husky pre-push 钩子（push 前跑单测）
bash nextjs/scripts/local-latest.sh      # 浅克隆同级 book-index-manager、装依赖、起服务 → http://localhost:3000
# 之后只需：cd nextjs && npm run dev:latest
# 出 PR 截图：cd nextjs && npm run shot -- /read/d59f2ew0ctmo   → docs/pr-screenshots/
```

分支流程（所有 PR 投 dev）、UI 源码直连的细节、发测试站步骤见 [`docs/开发流程.md`](docs/开发流程.md)。

**其他方式**

```bash
cd nextjs && npm install
# A. 读 GitHub raw / 数据站，UI 用 npm 装的版本
rm -f .env.local && npm run dev
# B. 读本地 D:\workspace 下的 book-index / book-text
bash scripts/setup-local.sh     # 写好 .env.local：NEXT_PUBLIC_MODE=local + BOOK_INDEX_WORKSPACE_ROOT
npm run dev                     # http://localhost:3000/book-index
```

Windows 上旧的 `next dev` 没退干净时新实例会悄悄改用 3001/3002，以 `Local:` 提示为准；卡住就 `rm -rf .next`。

改 `book-index-ui` 组件看效果：用上面的 `dev:latest`（源码直连，热更新）。不再需要 build 后拷 dist。

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

- **发布顺序**：先发 UI 包（dev 上发预发布 `x.y.z-rc.N`，定稿后发正式版 latest）→ 网站 dev 升依赖 → 切 `rc/vX.Y.Z` → merge commit 并入 main。反了 verify 必红。分支流程与预发布排号见 [docs/开发流程.md](docs/开发流程.md)。
- **发数据**（`data.yml`，index 与 text 两条流程独立发布，每条只推进自己的仓、另一个仓钉在线上版本）：
  - **book-text**：自动。每小时检查一次，book-text main 有新提交就发；每天 UTC 21:43 另有一次完整跑兜底。手动：`gh workflow run data.yml -f flow=text`。
  - **book-index**：手动。`gh workflow run data.yml -f flow=index`。
  - 两个仓一起按指定 ref 发（回滚用）：`flow=both`，ref 不是 main 时勾 `allow_ref_override`。
- **发布后验证**：`curl -s "https://data.openguji.com/latest.json?cb=$RANDOM$RANDOM"` 看 commit（必须带随机串，EdgeOne 会给旧副本）；线上是哪一版看 `/api/version`。
- 完整流程见 [docs/runbook.md](docs/runbook.md)；Secrets 统一在私有仓 guji-dev-secret（说明见 ai-team 仓 `通用/` 与 Ops）。

## 数据源模式

`NEXT_PUBLIC_DATA_SOURCE`：`cos`（生产）· `bundle`（CI 缺 COS 凭证时的降级）· `local`（dev 读本地仓）· `github`（dev 无本地仓）。
`NEXT_PUBLIC_MODE=local` 会关闭静态导出并打包 `*.local.ts` API route，CI 里显式置空。环境变量清单见 `nextjs/.env.example`。

## 更多

- 路线图与各板块说明：站内 [/roadmap](https://www.kaiyuanguji.com/roadmap)、[/typesetting](https://www.kaiyuanguji.com/typesetting)、[/extraction](https://www.kaiyuanguji.com/extraction)、[/toolkit](https://www.kaiyuanguji.com/toolkit)、[/storage](https://www.kaiyuanguji.com/storage)、[/intelligence](https://www.kaiyuanguji.com/intelligence)
- 项目组：https://github.com/open-guji · 问题反馈：[issues](https://github.com/open-guji/kaiyuanguji-web/issues)
