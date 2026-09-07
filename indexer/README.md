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

五个文件一起同步，别只同步一个——它们之间靠环境变量约定（`PRODUCTION_DIR`、`TEXT_DIR`）配合：

```bash
ssh root@122.51.91.177
cd /opt/indexer
B=https://raw.githubusercontent.com/open-guji/kaiyuanguji-web/main/indexer
for f in full-reindex.mjs reindex-and-purge.sh reindex-limited.sh purge-edgeone.mjs package.json README.md; do
  curl -fsSL -o "$f" "$B/$f"
done
chmod +x reindex-and-purge.sh reindex-limited.sh
npm install --omit=dev
md5sum *.mjs *.sh package.json     # 与仓库里 md5sum 对一遍
```

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
