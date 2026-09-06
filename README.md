# 开源古籍 (Kaiyuan Guji) 官网

> 让科技赋予古籍数字生命 — https://www.kaiyuanguji.com

本仓库是开源古籍项目官网的源码。Next.js 16（App Router）**静态导出**，托管在腾讯云 EdgeOne Pages；
索引数据不在站点里，由 CI 打包后走独立 CDN `data.kaiyuanguji.com`（新加坡 COS）；
搜索走 Meilisearch（L1，上海）+ 浏览器内 MiniSearch 分片（L2 兜底）。

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
| `ops/` | 探活与服务器救援脚本（`health-probe.sh` 由 `health-check.yml` 每 6 小时调用） |
| `.github/workflows/` | `deploy.yml`（部署）· `test.yml`（PR/夜间）· `health-check.yml`· `shanghai-cvm-rescue.yml` |

索引页的 React 组件**不在本仓**，在 npm 包 `book-index-ui`（源码 `open-guji/book-index-manager` 的 `ui/`）。
本仓 `nextjs/src/app/book-index/page.tsx` 只做数据源与搜索的装配。

## 本地开发

```bash
git clone https://github.com/open-guji/kaiyuanguji-web && cd kaiyuanguji-web
npm install                     # 仓库根：装 husky pre-push 钩子（push 前跑单测）
cd nextjs && npm install

# A. 不需要任何数据仓，读 GitHub raw（首次加载慢）
rm -f .env.local && npm run dev

# B. 读本地 D:\workspace 下的 book-index / book-index-draft / book-text（推荐）
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

**push 到 `main` 即发布**，`deploy.yml` 全自动（约 10 分钟）：单测 → 克隆三个数据仓 → `bundle-data.mjs` 打包 →
`sync-to-cos.mjs` 上传 → `next build`（cos 模式）→ 推 `edgeone-release` 分支 → purge CDN → 部署后 e2e。

- **发布顺序**：先 `npm publish` UI 包 → 再把依赖 bump 与 e2e 改动**同一批**推 main。反了 verify 必红。
- **只发数据**：数据仓 push 后不会自动触发；等每天北京 04:30 定时，或 `gh workflow run deploy.yml`。
- **发布后验证**：`curl -s "https://data.kaiyuanguji.com/latest.json?cb=$RANDOM$RANDOM"` 看 commit（必须带随机串，EdgeOne 会给旧副本）。
- 完整流程、Secrets 清单、应急手动发布见 overview 仓 `.claude/skills/release-web/SKILL.md`。

## 数据源模式

`NEXT_PUBLIC_DATA_SOURCE`：`cos`（生产）· `bundle`（CI 缺 COS 凭证时的降级）· `local`（dev 读本地仓）· `github`（dev 无本地仓）。
`NEXT_PUBLIC_MODE=local` 会关闭静态导出并打包 `*.local.ts` API route，CI 里显式置空。环境变量清单见 `nextjs/.env.example`。

## 更多

- 路线图与各板块说明：站内 [/roadmap](https://www.kaiyuanguji.com/roadmap)、[/typesetting](https://www.kaiyuanguji.com/typesetting)、[/extraction](https://www.kaiyuanguji.com/extraction)、[/toolkit](https://www.kaiyuanguji.com/toolkit)、[/storage](https://www.kaiyuanguji.com/storage)、[/intelligence](https://www.kaiyuanguji.com/intelligence)
- 项目组：https://github.com/open-guji · 问题反馈：[issues](https://github.com/open-guji/kaiyuanguji-web/issues)
