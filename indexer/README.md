# kyg-indexer — Meilisearch 索引器（跑在上海服务器）

把 book-index-draft + book-index（元数据）与 book-text（整理本正文）全量推到同机的 Meilisearch（`:7700`），
重建成功后 purge EdgeOne 上 `api.kaiyuanguji.com` 的边缘缓存。**网站部署不会更新这个索引**，它是独立的一条链路。

服务器：`root@122.51.91.177`，腾讯云国内账号，2 核 / 2GB / **无 swap**。Meili 是 docker 容器 `meilisearch`（v1.12），
`/opt/meili-watchdog.sh` 每 5 分钟探 `/health` 失败即重启容器。索引脚本在 `/opt/indexer/`，数据仓在 `/root/`。

## 文件

| 文件 | 作用 |
|---|---|
| `full-reindex.mjs` | 主程序。流式遍历三仓，建 works / juans / books / collections / entities 五个 index，最后 PATCH settings |
| `lib/work-fields.mjs` | works 文档里 `classification`（部）、`loss_status`（存佚）的取值逻辑。**full-reindex.mjs 依赖它，同步时要一起带上** |
| `reindex-and-purge.sh` | wrapper：读凭证 → 三仓 `git pull`（缺则 clone）→ 跑 full-reindex → 成功才 purge。**不要直接跑** |
| `reindex-limited.sh` | 平时用这个。`systemd-run --scope` 给上面的 wrapper 加 cgroup 上限（默认内存 600M / CPU 50%），压不垮 Meili 和 sshd |
| `purge-edgeone.mjs` | `purge_host api.kaiyuanguji.com`（EdgeOne 国际版凭证，读 `/opt/indexer/.env`） |

凭证：Meili master key 在 `/etc/meilisearch.env`（`MASTER_KEY`）；EdgeOne 子账号在 `/opt/indexer/.env`（`TENCENT_SECRET_ID/KEY`、`EDGEONE_ZONE_ID`、可选 `EDGEONE_ENDPOINT`、`PURGE_HOST`）。两者都 `chmod 600`，都不进仓库。

## 把仓库里的脚本同步到服务器

这些文件一起同步，别只同步一个——它们之间靠环境变量约定（`PRODUCTION_DIR`、`TEXT_DIR`）配合；
`full-reindex.mjs` 还 import 了 `lib/work-fields.mjs`（2026-09-30 起），漏了 `lib/` 会在启动时报 `ERR_MODULE_NOT_FOUND`
——那是在动任何索引之前就报错，线上索引不受影响，补上 `lib/` 重跑即可。

**上海机直连 GitHub 不通**（2026-09-06 实测：`git ls-remote` 60 秒超时，raw.githubusercontent.com 同样不通），
所以脚本用 `scp` 从本机推，数据仓经 `gh-proxy.com` 前缀拉（三仓的 origin 都已指向它）：

```bash
cd D:/workspace/kaiyuanguji-web/indexer
ssh root@122.51.91.177 'mkdir -p /opt/indexer/lib'
scp full-reindex.mjs reindex-and-purge.sh reindex-limited.sh purge-edgeone.mjs package.json README.md root@122.51.91.177:/opt/indexer/
scp lib/*.mjs root@122.51.91.177:/opt/indexer/lib/
ssh root@122.51.91.177 'cd /opt/indexer && chmod +x *.sh && npm install --omit=dev && md5sum *.mjs lib/*.mjs *.sh package.json README.md'
md5sum *.mjs lib/*.mjs *.sh package.json README.md    # 本机对一遍
```

## 数据仓怎么更新

wrapper 每次先 `git pull --ff-only` 三仓（origin 都是 `gh-proxy.com` 前缀）。**代理不可靠**：2026-09-07 拉 book-index 被 403，
拉 book-index-draft 却成功。pull 失败时 wrapper 会警告并用本地 checkout 继续，所以看到警告要另行更新数据。
最稳的办法是从本机经 SSH 直推（服务器三仓已设 `receive.denyCurrentBranch=updateInstead`，工作区干净时推上去即更新）：

```bash
cd D:/workspace/book-index && git push ssh://root@122.51.91.177/root/book-index main:main
cd D:/workspace/book-index-draft && git push ssh://root@122.51.91.177/root/book-index-draft main:main
cd D:/workspace/book-text && git push ssh://root@122.51.91.177/root/book-text main:main
```

推完在服务器上 `git -C /root/book-index log -1 --format='%h %cd' --date=short` 确认。

两个坑（2026-09-07 都踩过）：

- **别在服务器仓上 `git fetch --depth 1`**。三仓是 shallow clone，普通 `pull` 会按需加深历史所以能 fast-forward；
  一旦手动 `--depth 1` fetch，新的 origin/main 成了不相连的 shallow root，之后 `pull --ff-only` 永远报
  「Not possible to fast-forward」。已经弄成这样就 `git reset --hard origin/main`（工作区本来就该是干净的镜像）。
- gh-proxy 的 403 是瞬时的，同一分钟内重试常常就好。wrapper 现在遇到 pull 失败只警告不中止，
  所以**看到 ⚠ 就核对日志里打印的 HEAD 日期**，太旧就用上面的 SSH 直推。

## 跑一次重建

```bash
cd /opt/indexer
./reindex-limited.sh                 # 首次会自动 clone /root/book-text（约 130 MB）
# 参数原样透传：--dry-run 只统计不推；--only works,juans；--limit 500
```

约 10 分钟。中途另开一个 SSH 看 `free -m` 与 `curl -s localhost:7700/health`，都应正常——这就是 cgroup 限制的意义。

跑完检查：

```bash
set -a; . /etc/meilisearch.env; set +a
curl -s -H "Authorization: Bearer $MASTER_KEY" localhost:7700/stats | python3 -c "
import sys,json; d=json.load(sys.stdin); print('lastUpdate', d['lastUpdate'])
[print(' ', k, v['numberOfDocuments']) for k,v in d['indexes'].items()]"
```

期望：`lastUpdate` 是刚才；`works` 约 9 万、`books` 约 2 万、`entities` 约 3 万、`collections` 与生产索引一致、**`juans` 不再是 0**（book-text 有 61 部整理本，卷数合计约 2,000）。

## 定时

2026-09-06 实测 crontab 里**没有**重建任务，overview 仓的 `reindex-search.yml` 依赖的 self-hosted runner 也是 0 台，所以索引只能手动刷。
要恢复每晚自动重建，用限制版：

```
0 4 * * * /opt/indexer/reindex-limited.sh >> /var/log/indexer.log 2>&1
```

## 注意

- **2026-09-27（A4）起是 swap 式重建**：新数据先建到 `<idx>_tmp`，自检（前端形态查询）通过才
  `POST /swap-indexes` 原子换名，线上读到的索引全程有数据，不再有「DELETE 到重建完」之间的空窗。
  自检不通过就删掉 tmp、退出非 0，线上 `<idx>` 原样不动——不会出现"半成品覆盖旧索引"。
  代价：重建期间盘上短暂同时存在新旧两份数据（`<idx>` + `<idx>_tmp`），峰值盘占用比重建前
  高出约一个索引的量，2 核 2GB 无 swap 的机器上跑前留意 `df -h` 余量。
- 必须先同步脚本再重建：旧脚本 + 新数据会把 2 万多条已升格条目劣化成裸标题 stub（2026-08 事故）。
- 前端用的是公开只读 key，401/403 会立即熔断转 L2；轮换 key 要同时改 GitHub secret `MEILI_SEARCH_KEY` 与 `deploy.yml` 里的兜底值。
- 前端 `filter=is_draft = false` 依赖每个 doc 的 `is_draft` 字段，改 doc 结构时别丢它。
- 机器 IP 曾变过一次（2026-09-03）导致 EdgeOne 回源 522；现已绑弹性 IP。再遇 522 先去控制台确认 IP，再看源站组 `meili-shanghai`。

## 搜索页 v4 的筛选字段（overview#291 P1a，2026-09-30）

works 索引新增两个可过滤字段，`/api/search` 的 `filter` 参数据此放行（语法与限额见 `edge-functions/api/search.js` 文件头）：

| 字段 | 取值 | 来源 |
|---|---|---|
| `classification` | 部（一级分类）原文，如 `經部`／`史部`／`子部`／`集部`；没有的**空串**（前端当「未分類」） | Work 详情的 `classification.l1` |
| `loss_status` | `extant`／`partially_extant`／`lost`；别的或缺失为空串 | Work 的 `loss_status` |

已有的 `dynasty`、`has_image`、`has_text`、`has_collated`、`type` 不动。books／entities 这一版没加（设计稿表格的「部类」列只对作品有意义）。

**空串筛不到**：Meili 里 `classification = ""` 永远筛不到空值（要写 `IS EMPTY`）。代理已经把 `= ""`／`IN [..., ""]` 改写成 `IS EMPTY`，前端照索引里的值用 `""` 就行；直接打 Meili 时要自己写 `IS EMPTY`。

### 重建与验证

索引改动不重建不生效。只改了 works，可以只重建它（约 1 分钟量级，swap 零停机；每晚 04:15 的全量重建也会带上）：

```bash
cd /opt/indexer && ./reindex-limited.sh --only works
```

重建自检（swap 前）会核对 settings 里有新字段，并用 `is_draft = false AND classification IN ["史部"] AND loss_status IN ["extant"]` 跑一条查询，报 400 就放弃这次 swap、旧索引原封不动。

重建后验证（都只读；`$KEY` 用 search key 即可读 facets）：

```bash
# 1. settings：filterableAttributes 里有 classification、loss_status
curl -s -H "Authorization: Bearer $KEY" https://api.kaiyuanguji.com/indexes/works/settings | python3 -c "import sys,json; print(json.load(sys.stdin)['filterableAttributes'])"

# 2. 分布：与总目树的一级节点数量对得上（经/史/子/集 加 空串≈未分類）
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' https://api.kaiyuanguji.com/indexes/works/search \
  -d '{"q":"","limit":0,"filter":"is_draft = false","facets":["classification","loss_status"]}'

# 3. 朝代＋部类组合（经代理）：结果与预期一致
curl -s 'https://www.kaiyuanguji.com/api/search?q=%E5%8F%B2&index=works&filter=dynasty%20IN%20%5B%22%E5%94%90%22%5D%20AND%20classification%20%3D%20%22%E5%8F%B2%E9%83%A8%22'

# 4. 搜索质量不退步：基线 通过 59 / 失败 0 / known-issue 5 / 共 64（2026-09-30 重建前）
node nextjs/scripts/test-search-quality.mjs
```
