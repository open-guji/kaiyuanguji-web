# kyg-indexer — Meilisearch 索引器（跑在上海服务器）

把 book-index-draft + book-index（元数据）与 book-text（整理本正文）全量推到同机的 Meilisearch（`:7700`），
重建成功后 purge EdgeOne 上 `api.kaiyuanguji.com` 的边缘缓存。**网站部署不会更新这个索引**，它是独立的一条链路。

服务器：`root@122.51.91.177`，腾讯云国内账号，2 核 / 2GB / **无 swap**。Meili 是 docker 容器 `meilisearch`（v1.12），
`/opt/meili-watchdog.sh` 每 5 分钟探 `/health` 失败即重启容器。索引脚本在 `/opt/indexer/`，数据仓在 `/root/`。

## 文件

| 文件 | 作用 |
|---|---|
| `full-reindex.mjs` | 主程序。流式遍历三仓，建 works / juans / books / collections / entities 五个 index，最后 PATCH settings |
| `reindex-and-purge.sh` | wrapper：读凭证 → 三仓 `git pull`（缺则 clone）→ 跑 full-reindex → 成功才 purge。**不要直接跑** |
| `reindex-limited.sh` | 平时用这个。`systemd-run --scope` 给上面的 wrapper 加 cgroup 上限（默认内存 600M / CPU 50%），压不垮 Meili 和 sshd |
| `purge-edgeone.mjs` | `purge_host api.kaiyuanguji.com`（EdgeOne 国际版凭证，读 `/opt/indexer/.env`） |

凭证：Meili master key 在 `/etc/meilisearch.env`（`MASTER_KEY`）；EdgeOne 子账号在 `/opt/indexer/.env`（`TENCENT_SECRET_ID/KEY`、`EDGEONE_ZONE_ID`、可选 `EDGEONE_ENDPOINT`、`PURGE_HOST`）。两者都 `chmod 600`，都不进仓库。

## 把仓库里的脚本同步到服务器

六个文件一起同步，别只同步一个——它们之间靠环境变量约定（`PRODUCTION_DIR`、`TEXT_DIR`）配合。

**上海机直连 GitHub 不通**（2026-09-06 实测：`git ls-remote` 60 秒超时，raw.githubusercontent.com 同样不通），
所以脚本用 `scp` 从本机推，数据仓经 `gh-proxy.com` 前缀拉（三仓的 origin 都已指向它）：

```bash
cd D:/workspace/kaiyuanguji-web/indexer
scp full-reindex.mjs reindex-and-purge.sh reindex-limited.sh purge-edgeone.mjs package.json README.md root@122.51.91.177:/opt/indexer/
ssh root@122.51.91.177 'cd /opt/indexer && chmod +x *.sh && npm install --omit=dev && md5sum *.mjs *.sh package.json README.md'
md5sum *.mjs *.sh package.json README.md    # 本机对一遍
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

- 必须先同步脚本再重建：旧脚本 + 新数据会把 2 万多条已升格条目劣化成裸标题 stub（2026-08 事故）。
- 前端用的是公开只读 key，401/403 会立即熔断转 L2；轮换 key 要同时改 GitHub secret `MEILI_SEARCH_KEY` 与 `deploy.yml` 里的兜底值。
- 前端 `filter=is_draft = false` 依赖每个 doc 的 `is_draft` 字段，改 doc 结构时别丢它。
- 机器 IP 曾变过一次（2026-09-03）导致 EdgeOne 回源 522；现已绑弹性 IP。再遇 522 先去控制台确认 IP，再看源站组 `meili-shanghai`。
