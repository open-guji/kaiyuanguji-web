# 上海搜索机部署全文检索（GUJI-615）

给在上海搜索机上动手的人（Owen）。设计见 [../docs/design.md](../docs/design.md)。机器情况见 [indexer/README.md](../../indexer/README.md)：
`ubuntu@124.223.58.113`（美国机上别名 `search`），2 vCPU／3.6 GB／60 GB，免密 sudo，**连不上 GitHub**，和 Meili 共机。

全文检索服务只监听 `127.0.0.1:8765`，不对外。对外路由（EdgeOne 边缘函数）是 GUJI-616 的事，本清单不碰网关、防火墙、EdgeOne。
**凭据不进仓、不进卡、不进聊天**；本清单不需要任何密钥。

## 0. 先确认（每步结果贴到 GUJI-615）

```bash
ssh search 'python3 --version; df -h /opt; free -m; systemctl is-active meilisearch; ls /opt/indexer/.lock 2>/dev/null || echo 无锁'
```

磁盘要留得出：一个全量包解压约 5 GB，轮换时最多同时有 current、previous、新包三份，约 15 GB；`rotate.sh` 另要求 5 GB 余量。

## 1. 推代码、装服务

在能连 GitHub 的机器上（PR #478 合入后用 main，合入前用分支 `m5/fulltext-v2`）：

```bash
cd kaiyuanguji-web && git pull
tar cf - fulltext | ssh search 'rm -rf /tmp/fulltext && tar xf - -C /tmp && sudo bash /tmp/fulltext/deploy/install.sh --app-src /tmp/fulltext'
```

`install.sh` 会建 `fulltext` 系统用户、`/opt/fulltext/{app,bin,releases}`、systemd 单元 `fulltext.service`、`/etc/fulltext.env`（已有就不动）。**不启动服务**。

## 2. Python 依赖（venv，走腾讯云 PyPI 镜像）

```bash
ssh search 'sudo python3 -m venv /opt/fulltext/venv \
  && sudo /opt/fulltext/venv/bin/pip install -q -i https://mirrors.cloud.tencent.com/pypi/simple tantivy==0.26.2 \
  && echo FT_PYTHON=/opt/fulltext/venv/bin/python | sudo tee -a /etc/fulltext.env \
  && /opt/fulltext/venv/bin/python -c "import tantivy; print(tantivy.__version__)"'
```

版本必须是 0.26.2（和建包用的一样，索引格式随版本变）。镜像不通就在别处 `pip download tantivy==0.26.2 --platform manylinux2014_x86_64 --only-binary=:all: --python-version <机上版本>`，scp 过去装。

## 3. 能不能从 COS 取包

全量包由 GitHub Actions `Fulltext build` 传到 COS，指针是 `fulltext/latest.json`。桶名在本仓 secret `COS_BUCKET` 里，**问 sheldon 或在控制台看，别贴到卡上**。

```bash
ssh search 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://<桶名>.cos.ap-shanghai.myqcloud.com/fulltext/latest.json'
# 同地域内网域名（轻量服务器若支持，走内网不计外网流量）：
ssh search 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://<桶名>.cos-internal.ap-shanghai.tencentcos.cn/fulltext/latest.json'
```

- 200：能取，记下哪个域名能通、多快。
- 403：桶不是公共读。**停下，在卡上说一声**，不要往机器上放 COS 密钥，我来定办法。
- 404：Actions 还没传过包，先等。

## 4. 第一次轮换并启动

```bash
ssh search 'sudo /opt/fulltext/bin/rotate.sh --latest https://<能通的域名>/fulltext/latest.json; echo 退出码 $?'
ssh search 'sudo systemctl enable fulltext && systemctl status fulltext --no-pager | head -5'
```

`rotate.sh`：读指针 → 下载并流式解压 → 逐文件 sha256 → 起临时实例自检（端口 18765，查「太極」须有结果）→ 切 `current` → 启动/重载服务 → `/healthz`。
退出码：0 成功；6 锁忙（Meili 夜间重建在跑，错开再来）；8 包或指针不合格；9 磁盘不足；10 自检失败（current 未动）；11 切换后不健康已自动切回；12 要人工处理。
任何非 0，把输出尾部和 `sudo journalctl -u fulltext -n 50` 贴卡上。

## 5. 实测（判据，结果贴 GUJI-615）

```bash
# 冒烟
ssh search 'curl -s "http://127.0.0.1:8765/api/fulltext?q=%E5%AD%B8%E8%80%8C%E6%99%82%E7%BF%92%E4%B9%8B&limit=3" | head -c 600'
# 延迟：并发 1／4 各一轮（每轮前 sudo systemctl restart fulltext 并等 /healthz 200）
tar cf - fulltext/eval | ssh search 'tar xf - -C /tmp'
ssh search 'cd /tmp/fulltext && python3 eval/eval_latency.py --base http://127.0.0.1:8765 --queries eval/queries.json \
  --concurrency 1 --passes 2 --group book --label SH-c1 --out /tmp/latency_SH_c1.json'
# 内存：服务常驻与峰值、Meili 是否受影响
ssh search 'systemctl show fulltext -p MemoryCurrent -p MemoryPeak; free -m; systemctl show meilisearch -p MemoryCurrent'
```

**与 Meili 共机的低流量判据**（10-19 改；原先的"热 p95 ≤ 150 ms、并发 4"要求索引整个常驻内存，3.6 GB 的搜索机做不到）。
测前先确认 `/etc/fulltext.env` 已按模板改成 `FT_WARM=0`、`FT_MAX_CONCURRENT=1`、`FT_QUEUE_MAX=4`、`FT_TIMEOUT_S=6.0`，unit 里有 `IOReadBandwidthMax`（`install.sh` 重装一次即可）；
只跑并发 1，**不跑并发 4**；同时每分钟测一次 Meili 搜索延迟，和服务停着时比。

| 判据 | 目标 |
|---|---|
| 244 条，并发 1，冷启动后第一遍 p95 | ≤ 5 s（504 ≤ 5%） |
| Meili 搜索延迟 | 测试期任意 15 次滑窗 p95 ≤ 200 ms（10-19 改：基线 84 ms，1.5 倍线太紧，138 ms 用户感觉不到）；无 OOM、无重启 |
| 服务内存 | 常驻 ≤ 800 MB（`MemoryHigh`） |
| Meili 夜间重建窗口内 | 全文可以慢或 503，Meili 重建时长不明显变长 |

每轮另记 `systemctl show fulltext -p IOReadBytes -p IOReadOperations`（测前测后各一次），看卡在带宽还是 IOPS 上。

**停的条件**：Meili 延迟超过判据、可用内存 < 400 MB、或 Meili 不通，立刻 `sudo systemctl stop fulltext`，并在网站上关全文（Actions「Fulltext switch」选 off）。

达不到判据的，按规划第 4 条「另开机器要再问用户」，先在卡上报数字，不自行加机器。

## 6. 以后每次更新

`sudo /opt/fulltext/bin/rotate.sh --latest <同上 URL>`（已是最新会直接退出 0）。回滚：`sudo /opt/fulltext/bin/rollback.sh`。
夜间自动增量与监控是 GUJI-617，届时再接 cron／timer。
