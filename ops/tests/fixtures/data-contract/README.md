# data-contract 测试夹具

- `old/entry/*.json`：线上**旧格式**（schema-v2 之前）的 6 个真实条目（work／book／collection／entity 各型，含一个没有 `schema_version` 的老 book），
  取自 data.kaiyuanguji.com 2026-10-07（latest.json commitId `41e8ec940e39`）。`old/{latest,version,meta}.json` 同一时刻的线上指针与计数。
- `v2/entry/*.json`：book-index `schema-v2` 分支（`18dbf0f`）`build/contract-sample/entry/` 的 22 个条目＋`draft/entry/` 的 4 个草稿条目——
  schema-v2 build 产物的固定样例（`make_contract_sample.py`，「给网站做 contract 测试」，overview#458）。

两套都必须通过 `ops/data-contract.mjs` 的校验（旧格式不报错、新格式多出的 `_` 派生字段不算错）。
book-index 的样例变了，把这里重新拷一份即可；校验器对它报了新的 block，就是 book-index 改格式却没同步网站的信号。
