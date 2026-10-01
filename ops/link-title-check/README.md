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
- stdout 打印「核对 N 个链接，不符 M 个」及不符明细；
  `--out` 另写 JSON（每条含 source_page, href, name, kind,
  status, title, ok, reason）。
- 有不符退出码 1，全对 0。

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

## 与 ops/read-links-check.mjs 的分工

- `read-links-check.mjs`：查 200 与数据文件——卡片点进去真能读、
  `manifest.json` / `index.json` / 首章文件都在（防 404）。
- 本脚本：查书名对不对——链接上的名字与目标页 `<title>` 是否一致
  （繁简差异用 opencc t2s 归一后再比）。
