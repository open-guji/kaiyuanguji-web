# 阅读首页链接核对（link-title-check）

核对 `/read` 首页列出的站内链接：逐个打开目标页，取 `<title>`，
繁转简后检查「链接上的书名」是否出现在 title 里，输出不符清单。

## 用法

```bash
pip install -r requirements.txt
python3 ops/link-title-check/check.py --base https://staging.kaiyuanguji.com
python3 ops/link-title-check/check.py --base https://staging.kaiyuanguji.com \
    --pages /read --concurrency 4 --timeout 20 --out out.json
```

- `--pages` 可多值，默认只查 `/read`。
- stdout 打印「核对 N 个链接，不符 M 个，重试后才成功 R 个」及不符明细；
  `--out` 另写 JSON（每条含 source_page, href, name, kind,
  status, title, ok, reason, attempts, retried_ok）。
- 有不符退出码 1，全对 0。
- `--meta-home` 只跑元数据首页模式（见下），`--data` 指定数据站
 （默认 `https://data.kaiyuanguji.com`）。

## 判定规则

名字位置按优先级：`pk`（卡片 `<h3>`，忽略 aria-hidden 竖排单字）→
`t`（`span.bim-rh-t`）→ `bu-h`（`<b>`）→ `period`
（`/read?period=` 的 `span.bim-rh-pl`）→ `node-span`
（`/read?node=` 的第一个非隐藏 `<span>`）→ `nav`（文字以 `→` 结尾，
不比名字）→ `plain`（整段文字）。按 href 去重保留首个，
跳过指向 `/read` 自身的链接。

HTTP 200 且 `t2s(name) in t2s(title)`（两边去首尾空白，`·` 等标点保留）
为对；否则记不符，原因分 `HTTP xxx` / `请求失败` / `未抽到名字`
（非 nav 名字为空，先过 200 判定）/ `title 不含名字`。

实测样例（`fixtures/read-home.html`，2026-10-01 测试站抓取）：
去重后 145 条（pk 6、t 70、bu-h 4、node-span 23、nav 1、period 9、
plain 32）；去重前 153 条（t 75、nav 4）——5 个 pk 卡片与其 t 条目同书
重复、3 个 `bu-h` 与其「…全部 N 类 →」导航同 node 重复，均保留首次出现。

## 元数据首页模式（`--meta-home`）

条目不在 HTML 里抽，而是读数据文件：先 `GET {DATA}/latest.json`
取 `cacheKey`（没有就用 `commitId`），再
`GET {DATA}/current/meta-home/sections.json?v=<cacheKey>`，
按区取（区名, id, 名字）：`shelf.items[]` 取 `title`、
`related_catalogs[]` 取 `title`、`catalog_progress[]` 取
`work_id` 或 `collection_id`（都没有跳过）与 `name`、
`collection_groups[].items[]` 取 `title`、`bibliographers[]` 取 `name`、
`lineage[]` 取 `title`。样例（`fixtures/meta-home-sections.json`）
共 96 条，不去重（同 id 跨区分别记，但同一 URL 只请求一次）。

每条查 `{BASE}/item/<id>` 的 SSR `<title>`，判定用去「·」去空白的
归一化再比（`judge(..., mode="meta")`）。记录里 `source_page` 填
`meta-home:<区名>`，`kind` 填区名。

## 重试规则（两种模式都要）

目标页请求遇到 HTTP 503 或超时／连接失败时最多重试 2 次，
每次间隔 3 秒；其他状态码不重试。每条记录带 `attempts`（实际请求次数）
与 `retried_ok`（重试后拿到 200 为 true）。首页本身（`/read` 页、
`latest.json`、`sections.json`）同样重试，仍失败则报错退出 1。

## 与 ops/read-links-check.mjs 的分工

- `read-links-check.mjs`：查 200 与数据文件——卡片点进去真能读、
  `manifest.json` / `index.json` / 首章文件都在（防 404）。
- 本脚本：查书名对不对——链接上的名字与目标页 `<title>` 是否一致
  （繁简差异用 opencc t2s 归一后再比）。
