# kyg-indexer — Meilisearch 索引器（跑在上海搜索机）

把 book-index-draft + book-index（元数据）与 book-text（整理本正文）全量推到同机的 Meilisearch（`:7700`），
重建成功后 purge EdgeOne 上 `api.kaiyuanguji.com` 的边缘缓存。**网站部署不会更新这个索引**，它是独立的一条链路。

服务器（2026-09-27 起）：`ubuntu@124.223.58.113`（腾讯云轻量 · 上海，2 vCPU / 3.6 GB / swap 4 GB / 60 GB 盘，Ubuntu 26.04）。
用 `ubuntu` 用户登录、免密 `sudo`，**root 不能直接登录**；美国机上的 SSH 别名是 `search`。

- Meili v1.12.8 是 **systemd 服务 `meilisearch`**（不是 docker）：二进制 `/usr/local/bin/meilisearch`，以 `meilisearch` 用户运行，
  数据 `/var/lib/meilisearch/data/data.ms`，dump 在 `/var/lib/meilisearch/data/dumps/`，监听 `0.0.0.0:7700`，带 `--max-indexing-memory 1GiB`。
  看状态 `systemctl status meilisearch`，看日志 `sudo journalctl -u meilisearch`。**没有 watchdog**（旧机那个「探不通就重启」的脚本没装）。
- EdgeOne 的 `api.kaiyuanguji.com` **直接回源到 7700**（HTTP），机上没有 nginx、没有证书。
- 索引脚本在 `/opt/indexer/`（属 root），数据仓在 `/root/book-index`、`/root/book-index-draft`、`/root/book-text`（属 root）。所以下面的命令都带 `sudo`。
- 采集器 srvmon（`~/srvmon/`，用户级服务）每 15 秒记一次内存、负载和 Meili 健康，保留 48 小时。
- 旧机 `122.51.91.177`（2 GB、docker、watchdog）2026-10-02 已停服、到期释放，别再登它。

## 文件

| 文件 | 作用 |
|---|---|
| `full-reindex.mjs` | 主程序。流式遍历三仓，建 works / juans / books / collections / entities 五个 index，最后 PATCH settings |
| `lib/work-fields.mjs` | works 文档里 `classification`（部）、`loss_status`（存佚）的取值逻辑。**full-reindex.mjs 依赖它，同步时要一起带上** |
| `lib/sort-fields.mjs` | `era_rank`、`title_sort` 排序字段的取值逻辑。同上，**漏了就起不来** |
| `lib/doc-floor.mjs` | swap 前文档数下限闸的判定（新建的比线上少一半以上不换）。同上，**漏了就起不来** |
| `reindex-and-purge.sh` | wrapper：读凭证 → 三仓 `git pull`（缺则 clone）→ 跑 full-reindex → 成功才 purge。**不要直接跑** |
| `reindex-limited.sh` | 平时用这个。`systemd-run --scope` 给上面的 wrapper 加 cgroup 上限，压不垮 Meili 和 sshd。脚本里的缺省值（内存 600M / CPU 50% / 批 200）是给旧 2 GB 机定的，在现在这台上全量要近 40 分钟；夜间 workflow 和手动跑都用下面「跑一次重建」里那组放宽的参数（约 8 分钟） |
| `purge-edgeone.mjs` | `purge_host api.kaiyuanguji.com`（EdgeOne 国际版凭证，读 `/opt/indexer/.env`） |

凭证：Meili master key 在 `/etc/meilisearch.env`（`MASTER_KEY`）；EdgeOne 子账号在 `/opt/indexer/.env`（`TENCENT_SECRET_ID/KEY`、`EDGEONE_ZONE_ID`、可选 `EDGEONE_ENDPOINT`、`PURGE_HOST`）。两者都 `chmod 600`，都不进仓库。

## 把仓库里的脚本同步到服务器

这些文件一起同步，别只同步一个——它们之间靠环境变量约定（`PRODUCTION_DIR`、`TEXT_DIR`）配合；
`full-reindex.mjs` 还 import 了 `lib/work-fields.mjs`、`lib/sort-fields.mjs`（2026-09-30 起）、`lib/doc-floor.mjs`（2026-10-06 起），漏了 `lib/` 会在启动时报 `ERR_MODULE_NOT_FOUND`
——那是在动任何索引之前就报错，线上索引不受影响，补上 `lib/` 重跑即可。

**搜索机在墙内，直连 GitHub 不通**（npm 官方源也慢），所以脚本从一台能连 GitHub 的机器经 SSH 推过去，数据仓经 `gh-proxy.com` 前缀拉（三仓的 origin 都已指向它）。
`/opt/indexer` 属 root，`scp` 写不进去，用 `tar` 经管道加 `sudo` 解开（在仓库的 `indexer/` 目录下执行；`.env` 和 `node_modules` 不在包里，不会被覆盖）：

```bash
cd kaiyuanguji-web/indexer            # 先 git pull 到要上线的那个提交
S=ubuntu@124.223.58.113               # 美国机上可以直接写 search
tar cf - full-reindex.mjs reindex-and-purge.sh reindex-limited.sh purge-edgeone.mjs package.json package-lock.json README.md lib \
  | ssh $S 'sudo tar xf - -C /opt/indexer --no-same-owner && cd /opt/indexer && sudo chmod +x *.sh && md5sum *.mjs lib/*.mjs *.sh package.json'
md5sum *.mjs lib/*.mjs *.sh package.json    # 本机对一遍，两边要逐个相同
# 只有 package.json / package-lock.json 变了才需要重装依赖（走国内镜像）：
ssh $S 'cd /opt/indexer && sudo npm ci --omit=dev --registry=https://registry.npmmirror.com'
```

同步完**先干跑再重建**（见下面「跑一次重建」）。**凡是 `indexer/` 有合入，都要在下一次夜间重建之前同步过去**：
机上的 `/opt/indexer` 是手工同步的副本，夜间重建不会自己更新它。2026-10-01 就因为漏同步，旧脚本读不到 book-text 新结构，
两晚重建都把 juans 建成了 0 条（约 29 小时搜不到整理本正文）。

## 数据仓怎么更新

wrapper 每次先 `git pull --ff-only` 三仓（origin 都是 `gh-proxy.com` 前缀）。**代理不可靠**：2026-09-07 拉 book-index 被 403，
拉 book-index-draft 却成功。pull 失败时 wrapper 会警告并用本地 checkout 继续，所以看到警告要另行更新数据。
所以另有一条后备：**美国机每晚北京 03:50（重建前）经 SSH 把三仓直推过来**（crontab 跑 overview 仓的 `scripts/web/sync-search-repos.sh`，
日志在美国机 `~/.local/state/kyg-sync.log`）。服务器三仓已设 `receive.denyCurrentBranch=updateInstead`，工作区干净时推上去即更新。
要手动推，从任何一台有完整 clone、能 SSH 到搜索机的机器上（三仓在 `/root` 下属 root，所以远端要用 `sudo git-receive-pack`）：

```bash
S=ubuntu@124.223.58.113
for r in book-index book-index-draft book-text; do
  git -C <本机的 $r 仓> push --receive-pack="sudo git-receive-pack" ssh://$S/root/$r main:main
done
```

推完在服务器上 `sudo git -C /root/book-index log -1 --format='%h %cd' --date=short` 确认。

两个坑（2026-09-07 都踩过）：

- **别在服务器仓上 `git fetch --depth 1`**。三仓是 shallow clone，普通 `pull` 会按需加深历史所以能 fast-forward；
  一旦手动 `--depth 1` fetch，新的 origin/main 成了不相连的 shallow root，之后 `pull --ff-only` 永远报
  「Not possible to fast-forward」。已经弄成这样就 `git reset --hard origin/main`（工作区本来就该是干净的镜像）。
- gh-proxy 的 403 是瞬时的，同一分钟内重试常常就好。wrapper 现在遇到 pull 失败只警告不中止，
  所以**看到 ⚠ 就核对日志里打印的 HEAD 日期**，太旧就用上面的 SSH 直推。

## 跑一次重建

先干跑（只统计、不写索引，约 1.5 分钟），看五个索引的条数对不对：

```bash
cd /opt/indexer
sudo bash -c 'set -a; . /etc/meilisearch.env; set +a
  DRAFT_DIR=/root/book-index-draft PRODUCTION_DIR=/root/book-index TEXT_DIR=/root/book-text \
  MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=$MASTER_KEY node full-reindex.mjs --dry-run' | grep -E "WORKS|DONE"
```

条数正常再正式重建（参数与夜间 workflow 相同）：

```bash
cd /opt/indexer
sudo env CPU_QUOTA=100% MEM_HIGH=700M MEM_MAX=1G NODE_HEAP=512 BATCH_SIZE=1000 MAX_CONCURRENT=2 ./reindex-limited.sh
# 参数原样透传：--only works,books,entities（逗号分隔）；--limit 500
# 注意：--limit 只给本地/测试用的 Meili；对着线上索引带 --limit 会被下限闸挡住（线上不动）。同步后验证能启动用 --dry-run
```

全量约 8 分钟，只重建 works 约 5 分钟。swap 式重建，线上全程有数据。中途另开一个 SSH 看 `free -m` 与 `curl -s localhost:7700/health`，都应正常。

跑完检查：

```bash
set -a; . <(sudo cat /etc/meilisearch.env); set +a
curl -s -H "Authorization: Bearer $MASTER_KEY" localhost:7700/stats | python3 -c "
import sys,json; d=json.load(sys.stdin); print('lastUpdate', d['lastUpdate'])
[print(' ', k, v['numberOfDocuments']) for k,v in d['indexes'].items()]"
```

期望：`lastUpdate` 是刚才；2026-10-02 的实数是 `works` 95,055、`books` 20,899、`entities` 30,994、`collections` 84、**`juans` 1,812**。
**五个都要看，不能只看脚本报 success**：swap 前的自检对 juans 不查命中数。10-02 起 swap 前另有文档数下限闸（见下），新建的比线上少一半以上不换；但这条闸只防「大幅变少」，仍要核对各索引数量。

## 定时

每晚自动重建**不在本机 crontab 里**，由 overview 仓（open-guji-core/overview）的 `.github/workflows/reindex-search.yml` 触发，
跑在本机的 self-hosted runner 上（`search-shanghai-new`，labels `self-hosted, shanghai`，装在 `/opt/actions-runner`，以 root 运行）。
workflow 做三件事：三仓 `git pull`（gh-proxy，失败重试 5 次）→ `reindex-limited.sh`（上面那组参数）→ 导出一份 Meili dump，机上保留最近 3 份。

- cron 写的是 `0 20 * * *`（UTC，= 北京 04:00），但 GitHub 的 schedule 会延迟，**实际在 23:40Z 前后（北京 07:40 左右）才跑**。
- 手动触发：`gh workflow run reindex-search.yml -R open-guji-core/overview`，或者按上面「跑一次重建」直接在机上跑。
- 在这之前，美国机 03:50（北京）先把三仓直推过来，见「数据仓怎么更新」。

## 注意

- **2026-09-27（A4）起是 swap 式重建**：新数据先建到 `<idx>_tmp`，自检（前端形态查询）通过才
  `POST /swap-indexes` 原子换名，线上读到的索引全程有数据，不再有「DELETE 到重建完」之间的空窗。
  自检不通过就删掉 tmp、退出非 0，线上 `<idx>` 原样不动——不会出现"半成品覆盖旧索引"。
  自检之外还有**文档数下限闸**（`lib/doc-floor.mjs`，overview#122）：线上原来有文档、新建的少了一半以上，同样放弃 swap（10-02 juans 两晚建出 0 条换上去的事故）。线上或新建索引的条数读不到时同样不换。通过时日志里每个索引有一行 `📏 [<idx>] 下限闸通过：线上 N 条 → 新 M 条`，没有这行说明脚本不是新版。`--limit` 的试跑结果条数少，也会被挡住；确实要大幅缩减（或确实要把试跑结果换上线）时带 `--allow-shrink`（或 `FORCE_SHRINK=1`）。
  代价：重建期间盘上短暂同时存在新旧两份数据（`<idx>` + `<idx>_tmp`），峰值盘占用比重建前
  高出约一个索引的量（现在整库约 2 GB，盘 60 GB，余量充足）。内存上，重建时 Meili 自己真正吃掉的约 1–1.5 GB，
  机器是 3.6 GB 加 4 GB swap，够用；2026-10-02 之前 swap 只有 2 GB，重建时曾顶满。
- 必须先同步脚本再重建：旧脚本 + 新数据会把 2 万多条已升格条目劣化成裸标题 stub（2026-08 事故）。
- 前端用的是公开只读 key，401/403 会立即熔断转 L2；轮换 key 要同时改 GitHub secret `MEILI_SEARCH_KEY` 与 `deploy.yml` 里的兜底值。
- 前端 `filter=is_draft = false` 依赖每个 doc 的 `is_draft` 字段，改 doc 结构时别丢它。
- 遇到 522 先分清是哪一种：
  - **成段、所有请求都 522**：先确认源站地址还对不对。在 EdgeOne 控制台：站点 `kaiyuanguji.com` → 域名服务 → 域名管理 → `api.kaiyuanguji.com` → 源站地址，
    应为 `124.223.58.113`、HTTP、回源端口 7700（**没有叫 api.kaiyuanguji.com 的站点，也没有用源站组**）。再登机器看 `systemctl status meilisearch`。
  - **零星、同一时刻有的请求成功有的 522**：多半是境外边缘节点跨境回源丢包（境外探针每天会碰到几次，每次几分钟），
    源站本身是好的；国内节点回源不跨境，不受影响（overview#353）。

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
cd /opt/indexer && sudo env CPU_QUOTA=100% MEM_HIGH=700M MEM_MAX=1G NODE_HEAP=512 BATCH_SIZE=1000 MAX_CONCURRENT=2 ./reindex-limited.sh --only works
```

重建自检（swap 前）会核对 settings 里有新字段，并用 `is_draft = false AND classification IN ["史部"] AND loss_status IN ["extant"]` 跑一条查询，报 400 就放弃这次 swap、旧索引原封不动。

重建后验证（都只读；第 2–4 步用 search key 即可，**第 1 步读 settings 要 master key**，公开的 search key 只有 `search` 权限，所以在机上打本机端口）：

```bash
# 1. settings：filterableAttributes 里有 classification、loss_status（在搜索机上跑）
set -a; . <(sudo cat /etc/meilisearch.env); set +a
curl -s -H "Authorization: Bearer $MASTER_KEY" localhost:7700/indexes/works/settings | python3 -c "import sys,json; print(json.load(sys.stdin)['filterableAttributes'])"

# 2. 分布：与总目树的一级节点数量对得上（经/史/子/集 加 空串≈未分類）
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' https://api.kaiyuanguji.com/indexes/works/search \
  -d '{"q":"","limit":0,"filter":"is_draft = false","facets":["classification","loss_status"]}'

# 3. 朝代＋部类组合（经代理）：结果与预期一致
curl -s 'https://www.kaiyuanguji.com/api/search?q=%E5%8F%B2&index=works&filter=dynasty%20IN%20%5B%22%E5%94%90%22%5D%20AND%20classification%20%3D%20%22%E5%8F%B2%E9%83%A8%22'

# 4. 搜索质量不退步：基线 通过 59 / 失败 0 / known-issue 5 / 共 64（2026-09-30 重建前）
node nextjs/scripts/test-search-quality.mjs
```
