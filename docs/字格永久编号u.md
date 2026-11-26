# 字格永久编号 u：网站怎么用

> 2026-11-26 起现行（web v0.2.35、book-index-ui 0.66.17）。规范真源：guji-format `spec/02` §4.10（guji-char v0.6）；身份账与迁移见 open-guji-cv / guji-manager 文档。本文只讲**网站侧**：读者链接、阅读页、校对票与改字票、开发者取 u。

## 一句话

格位 `a`（`页:列:格[子列]`，如 `137:1:8`）是**位置**：补一个字、重切一次、换图源，后面的格号都可能变。
**u 是身份**：册内唯一的正整数，发了永不改、永不复用。对外分享、存票、做引用一律用 u；格位只在当前版本里定位。

## 1. 读者链接（深链）

| 写法 | 含义 | 例子 |
|---|---|---|
| `/read/<书>/<册>?u=<n>` | 跳到 u 为 n 的那一格并高亮 | `/read/96mid1ogzk/028?u=14226`（殿本卷 28 第 97 页「奏」） |
| `/read/<书>/<册>?u=<n>~<m>` | 一段：从 n 到 m | `/read/96mid1ogzk/001?u=18308~18312` |
| `/read/<书>/<册>#<页:列:格>` | **旧写法**，按格位跳，照旧可用 | `/read/96mid1ogzk/028#97:4:5` |
| `/read/<书>/<册>?cell=<页:列:格>[~<页:列:格>]` | 按格位跳的查询串写法，照旧可用 | `/read/96mid1ogzk/028?cell=97:4:5` |

再举两个线上已验证的例子：全唐文 `/read/995ejelvk0/001?u=13817`（第 129 页「六」）、史記 `/read/988g3f0wsu/001?u=9440`（第 96 页「卷」）。

规则：

- **u 优先**。地址同时带 `?u=` 和 `#格位` 时按 u 跳；u 在本册查不到（不是这一册、或该册正文还没有 u）才用 `#格位` 兜底。
- 网站自己生成的格链接（`cellHref()`）两个都写：`?u=<n>#<格位>`，旧页面、旧缓存也能跳到。
- **阅读页地址会自动写 u**：读者点目录标题、或地址里是 `#格位` 时，阅读页把对应的 `?u=` 补进地址栏（并去掉 `?cell=`），读者直接复制地址栏转发出去，跨重切也不漂。
- **专名出处**（实体详情页「出处」列表）的链接写 `?u=<起>[~<止>]`；该段没有 u 时退回 `#起~止`。
- 一个 u 在 char 里出现两次（数据坏了）两格都不认，免得跳错格。

## 2. 校对票、改字票按 u 存

读者在网站上提交的意见都带 u（有 u 的格就带，老文本没有 u 照收）：

| 接口 | 存在哪 | u 字段 |
|---|---|---|
| `POST /api/cellreview`（精校页 `/proofing/<书>/<册>` 每格的选字票） | 中心库 D1 `web_inbox`，`kind=cellreview`，键 `cr:` | `value.u` |
| `POST /api/charfix`（阅读页改字意见） | `web_inbox`，`kind=charfix` | 单字 `value.u`；一段或专名 `value.u_start`／`value.u_end`（两个须同时给） |

- u 必须是 1–99,999,999 的整数（`U_MAX`），不合法直接拒收。
- 精校页上每格的 u 来自待审单（`/api/pending` 的 `cells[].u`），待审单由中心库条目导出时带上；所以**待审单要按中心库条目重发**才会带新 u（`export_sheet`）。
- `web_inbox` 有一个虚拟列 `u`（只对 cellreview／charfix 生成：取 `value.u`，没有就取 `value.u_start`），查票可直接 `WHERE u = ?`：

  ```sql
  SELECT key, value FROM web_inbox WHERE kind = 'cellreview' AND book = '96mid1ogzk' AND u = 14226;
  ```

- 票的**键**仍是原来的形式（精校票按待审条目 `item`＋投票人；改字按格位），u 只在值里。去重、覆盖规矩不变。
- 2026-11-25 已按身份账给旧票回填 u（`guji uid web-backfill`，guji-manager）：2,411 张精校票 1,883 张有 u；部署后的新票全部带 u。剩下没 u 的是换图源前的旧票或已作废的格，定为不追溯。
- 每日出站（`proofing-sync.yml`）把票整条并进中心库，u 随值带过去，下游（人审、定字）按 u 认格。

## 3. 开发者：从 char.json 取 u

正文数据 `<书>/<版本>/<册>.char.json`（数据站 `https://data.openguji.com/current/items/<书>/default/<册>.char.reader.json`）里每格都有 `a` 和 `u`：

```json
{ "pages": [ { "columns": [ { "cells": [ { "a": "137:1:8", "u": 18308, "c": "至" } ] } ] } ] }
```

- 站内代码用 `nextjs/src/lib/cell-u.ts`：
  - `collectU(char)` → `{ byA: Map<格位, u>, byU: Map<u, 格位> }`（本章对照）；
  - `parseCellLink(search)` 解析 `?u=`／`?cell=`；`resolveCellLink(link, idx)` 换成阅读器锚点；
  - `cellHref(book, vol, { a, u, end?, uEnd? })` 生成格链接（`?u=…#格位`）；
  - `anchorToU(anchor, idx)` 把阅读器锚点换回 `u` 查询串的值。
- 阅读页插件 `app/read/[id]/plugins/cell-link-plugin.ts`：每章取到 char 后把对照交给宿主（`onIndex`），并解析地址里的深链（`onResolve`）。
- 专名出处数据（`scripts/lib/mentions.mjs` 生成）每条例句带 `u`、`ue`（起止格的 u，`ue` 与 `u` 相同时省略），book-index-ui 的 `MentionItem` 同名字段，`mentionHref()` 据此写 `?u=`。
- Python 一侧（脚本、管线）直接读 char 的 `u`，或用 guji-manager 的身份账（`guji uid …`）在不同切分版本之间换算。

## 4. 新代码的规矩

- 需要**跨版本**指向一格（分享链接、存票、存引用、写日志）一律存 u；格位只作当前版本的显示和兜底。
- 拿不到 u（老文本、还没迁移的册）就照旧用格位，不要自己编号。
- 新加的写入接口照 `optU()`／`optUPair()`（`edge-functions/api/feedback.js`）校验 u。
