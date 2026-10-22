# 全文搜索 v2 设计

> Jira：GUJI-243（M5 全文搜索上线）及子卡 GUJI-612～617。规划文档：<https://claude.ai/code/artifact/e52fd210-c591-4dc4-8d33-26006dd53731>
> 本文是全文搜索后端（建包、检索服务、部署）的长期设计文档。2026-10-18 起代码从 overview 仓 `scripts/fulltext-search/` 迁到本目录，旧目录不再维护。

## 一、要做什么

开源古籍网站（kaiyuanguji.com）加一个"全文"搜索：在 book-text 全部正文（约 8,800 部书、7.6 亿字）里按字串查，结果按书分组，点进去定位到章内原文位置。

- **模糊（fuzzy，默认）**：繁简、异体按 `charmap.json` 归一后匹配（查"学而"能中"學而"）。
- **精确（exact）**：只认原字。
- **差一字（near）**：在模糊的基础上，查询串与原文差一个字（原文多一字、少一字或错一字）也算命中，给记不全原句的人用；≥4 字才放宽。
- 不做分词、不做相关度花样：古籍检索要的是"有没有、在哪里、有多少"。

## 二、为什么改（v1 → v2）

v1（overview 仓，2026-10-12 前后）选型 Tantivy 是对的，查询路径有三个问题：

| 问题 | v1 做法 | 后果 |
|---|---|---|
| 计数不准 | 先取前 400 个候选段，再逐段定位、分组 | 高频词（孔子 2,889 段）只看到 400 段，书单与命中数都残缺 |
| 依赖 book-text | 候选段要回读章 md 才能定位、出摘要 | 搜索机要放一份 book-text；冷查询逐个读文件，孔子／老子冷查 >3 秒、504 |
| 包太大 | 索引同时建 norm 与 orig 两套双字字段 | 全量 7.7 GB，上海机（60 GB 盘、3.6 GB 内存）吃紧 |

v2 的改法：

1. **每段原文存进索引**（`text`，只存不索引）。服务不再读 book-text。
2. **按书计数用聚合**：`entry` 是快字段，`searcher.aggregate` 一次算出每部书的命中段数，再排序分页。计数是准的，不截断。
3. **只取当前页的段**：当前页每部书按书内段序（`ord` 快字段）取前 `per_book` 段，只在这些段上定位、出摘要。
4. **去掉 orig 双字字段**：精确模式改为"norm 召回 → 在存储原文上筛原字"。

## 三、数据流

```
book-text（GitHub）
  └─ build/build_pack.py（GitHub Actions，阶段 2 / GUJI-614）
       └─ fulltext-<stamp>.tar.gz ＋ manifest.json → COS（复用本仓 COS_SECRET_*，路径另定）
            └─ 上海搜索机 deploy/rotate.sh --tar <URL> --manifest <URL>（阶段 3 / GUJI-615，Owen）
                 └─ service/run.py（127.0.0.1:8765，systemd: fulltext.service）
                      └─ EdgeOne 边缘函数 /api/fulltext（阶段 4 / GUJI-616，限流、开关）
                           └─ 前端全文 tab（nextjs/src/components/fulltext/，开关 NEXT_PUBLIC_FULLTEXT_TAB）
```

## 四、索引格式（schemaVersion = 2）

### 切段与字流（`common.py`，v1 原样保留）

- 章 md 按行切段，约 600 个可检索字一段，超长行在句号处断开，硬上限 1,200 字；`#` 标题行单独成段，并作为其后各段的 `label`。
- 可检索字：汉字、`□`、`〇`、ASCII 字母数字（小写）。组字式／阙文（`:zi[…]`、`[[…]]`、`[甲*乙]`、`{…}`、`[4E00]`）整体算一个占位字 `〓`。标点、空白不进字流，所以查询可以跨标点。
- 归一：`charmap.json` 一字对一字（5,255 条），orig 与 norm 字流等长、下标对齐。由 `build/gen_charmap.py` 生成：原有繁→简表（4,820 条）并上全站异体字表 `indexer/lib/variant-chars.json`（Meili 书名搜索在用，753 对）和 `variants-extra.json`（语义测试发现的缺口），按等价类合并，每类映射到一个代表字（优先异体表正字的简体）。2026-10-19 语义测试发现异体表 753 对里有 440 对全文不认（淸／清、靑／青、徳／德、歳／歲等），因此合并。
- **归一表随包走**：建包把 `charmap.json` 放进包里（manifest 的 `charmapSha256` 记它），服务打开索引时按包里这份归一查询（`source_tantivy._load_charmap`），换表与换索引在同一次 rotate 里生效；旧包没有这份文件时沿用代码自带的。增量更新（`update_books.py`）发现代码里的表与当前索引的不同，拒绝增量、改做全量（退出 7）。
- 偏移：一律是**章 md 内的 Unicode 码点下标**（前端按码点切）。

### 字段（`build/build_pack.py: build_schema()`）

| 字段 | 类型 | 用途 |
|---|---|---|
| `norm` | text，whitespace 分词，带位置 | 归一字流的相邻二字组；查询 ≥2 字走 term／phrase |
| `norm1` | text，只记频次 | 归一单字；查询 1 字走 term |
| `entry` | text raw，存储＋**快字段** | 书 ID；按书聚合、按书过滤 |
| `ord` | i64 **快字段** | 书内段序（章号升序、章内原文顺序），书内按它取段 |
| `long` | i64 存储＋快字段 | 所在章总长 ≥30 码点为 1；排序降权用 |
| `chapter` / `label` | text raw，存储 | 章号、所在章标题 |
| `start` / `end` | i64 存储 | 段在章 md 里的码点区间 |
| `text` | bytes 存储 | 段原文（UTF-8），即 `md[start:end]` |

整数一律 i64：`tantivy.Document` 把 Python int 当 i64，声明成 unsigned 会在写入时报类型错。

### 包内文件

`index/`、`titles.json`（书 ID→书名）、`boost.json`（书 ID→排序倍数，默认空）、`chapters.json`（书→章→原始字节 sha256）、`manifest.json`。
manifest 必有 `schemaVersion=2`、`stamp`、`createdAtEpoch`、`bookTextCommit`、`books`、`passages`、`indexBytes`、`files{bytes,sha256}`、`perBook{passages,commit}` 等（`check_manifest()`），`deploy/manifest_check.py` 拒收非 v2 包。

## 五、查询路径（`service/app.py: run_query`）

查询先过 `query_stream()` 得到 orig 与 norm 两个字流，全是标点空白 → 400。

**fuzzy**（norm 层的 phrase 命中＝段内归一字流含查询串，双字词元覆盖整段，所以计数是准的）：

- `group=book`：`book_counts()` 聚合出 `[{entry, count, long}]` → `rank_books()` 排书序 → 取 `[offset, offset+limit)` 的书 → 每部书 `passages(entry, per_book, in_order)` 取前几段 → 在段原文上 `locate()` 出 `matches` 与 `snippet`。
- `group=none`：按相关度直接取 `[offset, offset+limit)` 段。

**exact**：按 norm 召回、按 `ord` 顺序最多扫 `FT_EXACT_SCAN`（默认 3,000）段，在存储原文上筛原字（`orig_text()`，与 `stream()` 等价的正则快速版，有逐字对拍测试），再分组。候选超过上限时 `capped=true`、`total_books_capped=true`。常用字的精确查询总会撞上限，所以耗时受上限约束、不随库变大。

**near（差一字）**：查询归一后 ≥4 字才放宽，否则按 fuzzy。召回＝"少一字"的各个串，加上中间多一字／错一字时左右两半按位置拼的 phrase（tantivy phrase 支持给每个词元指定位置），取并集；一边只剩一个字时那边没有双字词元，只按另一边召回。候选按书内顺序每批取 2048 段，在归一原文（`norm_text()`，`orig_text` 再 `str.translate`）上用 `near_regex()` 核；**先核验、再对有效命中套 `FT_EXACT_SCAN` 上限**，有效命中到上限或超出时间预算（服务超时的 80%）才停，停下时 `capped=true`。只留展示要用的段，不累积全部候选。（10-22 按 ai-team PR #37 修正：旧版先截 3000 个候选再核，后面的真命中会丢，「學而習之」全库 2508 段只返回 466 段。）完全命中原串的书排前面；每组多给 `exact_count`。颠倒（两字互换）是编辑距离 2，不算。

**排序**（`service/ranking.py`）：书分 = boost × 章长系数（有命中在 ≥30 字的章为 1.0，否则 0.3）+ 0.1 × log(1 + 命中段数)；同分按命中段数、再按 entry。书内按原文顺序。

## 六、接口（契约 F1，前端已按此实现）

`GET /api/fulltext?q=&mode=fuzzy|exact|near&group=book|none&limit=1..50(10)&offset=0..&per_book=1..20(3)&entry=`

- `q` 超过 60 字截断并回 `truncated:true`；`entry` 只许字母数字。
- 响应（`group=book`）：`q, mode, normalized, truncated, total_hits(封顶 10000), capped, total_books, total_books_capped, has_more, groups[{entry, title, hit_count, hits[{chapter, label, passage[s,e], matches[[s,e]…], snippet}]}], took_ms`。`group=none` 时为 `hits[{entry, title, chapter, label, passage, matches, snippet}]`。样例：`contract/sample_response.json`。
- `snippet`：命中前后各 40 字，命中处 `<mark>`，其余 HTML 转义，前端可直接 innerHTML。
- 错误：400 `bad_query`；503 `busy`（并发闸满）／`warming`（预热中）／`index_unavailable`；504 `timeout`（3 秒）。
- 运维：`GET /healthz`；`POST /admin/reload`（只认本机来源）重开索引目录，返回新 stamp。
- **来源限制**（GUJI-616）：服务对公网开放（`FT_HOST=0.0.0.0`）时，非本机来源必须带请求头 `X-FT-Token` 等于机上 `FT_EDGE_TOKEN`（EdgeOne 边缘函数带，值配在 EdgeOne 项目变量 `FULLTEXT_TOKEN`）才能查 `/api/fulltext`，否则 404；没配令牌时非本机来源一律 404；`/healthz`、`/admin/*` 对非本机来源一律 404。令牌只填在机器和 EdgeOne 上，不进仓。

## 七、运行与部署（`deploy/`）

- 目录：`/opt/fulltext/{app,bin,releases/<stamp>,current→,previous→}`；服务读 `current/index`。
- `install.sh --app-src <本仓 fulltext/>`：装用户、脚本、systemd 单元，把 `common.py`、`charmap.json`、`service/` 同步到 `/opt/fulltext/app/`。
- `rotate.sh --latest <COS 上 fulltext/latest.json 的 URL>`：读指针 → 流式下载解压 → manifest 与逐文件 sha256 校验 → 磁盘闸 → 临时实例自检 → 原子切 `current` → reload → 健康检查，失败自动切回 `previous`；已是最新则直接退出 0。与 Meili 夜间重建共用锁 `/opt/indexer/.lock`。上海机操作清单见 `deploy/README.md`。
- 建包与上传：`.github/workflows/fulltext-build.yml`（手动触发）全量建包 → verify → `build/upload_cos.mjs` 传 `fulltext/<stamp>/` 并最后翻转 `fulltext/latest.json`，只留最新 2 个包；线上指针更新时拒绝覆盖。
- 配置：`/etc/fulltext.env`（模板 `deploy/fulltext.env.example`，无机密）。v2 起不需要 `FT_TEXT_ROOT`。Python 用 venv 时在其中加 `FT_PYTHON=/opt/fulltext/venv/bin/python`。
- 资源：systemd `MemoryHigh=800M`、`Nice=10`、IO idle，另加读盘硬上限 `IOReadBandwidthMax=30M`、`IOReadIOPSMax=600`（云盘调度器不认 idle 优先级）。与 Meili 共机时 `FT_WARM=0`、一次一条查询、服务超时 6 秒（见下节「上海机实测」）；换独立大内存机器再开预热（预读倒排／位置／快字段，不预读原文存储块）。
- 搜索机上不跑建包（2 核 3.6 GB 不够），只收包。

## 七·五、网站接入与全局开关（GUJI-616）

- 浏览器 → EdgeOne 边缘函数 `edge-functions/api/fulltext.js` → 搜索机 `FULLTEXT_ORIGIN`（带 `X-FT-Token: FULLTEXT_TOKEN`）。函数做参数白名单、按 IP 限流（30／分、600／时）、结果缓存 10 分钟，不把源站地址和令牌回给浏览器。
- **全局开关**：COS 公开文件 `fulltext/switch.json`（`{enabled, reason, updatedAt, by}`），用 GitHub Actions「Fulltext switch」一键写（state=on/off），不用重新构建发布，约 1 分钟全站生效。关时：`/api/fulltext?op=status` 回 `enabled:false`，前端「全文」tab 隐藏；搜索回 503 `disabled`，不再打搜索机。开关文件读失败沿用上次的值，从没读到过当关。EdgeOne 变量 `FULLTEXT_ENABLED=0` 是更硬的关（要重新部署才生效），只作兜底。前端构建期变量 `NEXT_PUBLIC_FULLTEXT_TAB=1` 仍是总闸。
- 搜索机侧：`FT_HOST=0.0.0.0`＋`FT_EDGE_TOKEN`（见第六节"来源限制"），安全组只开服务端口。

## 八、增量更新（`build/update_books.py`）

按 manifest `perBook.commit` 与 book-text 每部书最后提交比出 changed／added／removed；超过 200 本改做全量。硬链接复制当前索引到新目录，按 `entry` 删旧段、整本重写，校验段数后产出新目录；失败丢弃新目录，旧索引不动。只接受 v2 索引。

## 九、实测

42 部样本（`eval/books42.txt`，87,411 段，3,060 万字），244 条冻结查询（`eval/queries.json`），同一台云端容器、进程内单线程（`eval/inproc.py`）：

| | v1 | v2 |
|---|---|---|
| 索引大小 | 340 MB | 240 MB |
| 建包耗时／峰值内存 | 97 s／2.1 GB | 52 s／1.2 GB |
| 召回（group=none 全集 vs 暴力子串） | 244/244 | 244/244，且 group=book 的 total_hits、total_books、hit_count 合计与暴力一致 |
| 生产口径 p95（group=book, limit=10） | 87–94 ms（计数截在 400 段） | 8–11 ms（计数准确） |
| 精确模式最慢 | — | 约 200 ms（"之"、"爲"，撞 3,000 段扫描上限） |

**全量规模估计**：把 42 部样本每部复制 20 份（entry 加后缀）建成 174.8 万段的合成索引（真实全量 182.3 万段、7.6 亿字），同一容器进程内：

| | 20 倍合成 |
|---|---|
| 索引大小 | 3.9 GB（按字数折算，真实全量约 5 GB；v1 全量 7.7 GB） |
| 建索引 | 202 s（单进程，未并行切段） |
| 244 条 p50／p95／p99／最慢 | 9／15–17／22–35／150 ms |
| "之""人"（fuzzy，820 部书都中） | 25 ms，其中聚合 15 ms |
| "之""孔子"（exact，撞 3,000 段上限） | 120–150 ms |
| 进程峰值 RSS | 1.4 GB（大部分是 mmap 的索引文件页，可回收） |

合成数据词表比真实数据小，倒排更紧凑，数字偏乐观；上线判据（p95、并发、内存、与 Meili 共机）以上海机全量实测为准（GUJI-615）。上海机 systemd 设了 `MemoryHigh=800M`，mmap 的文件页也算进 cgroup，超了会被回收而变慢，实测时重点看。

**上海机实测（GUJI-615，10-19）与修正**：上面的估算只看了进程内存，没把"查询时要常驻缓存的索引文件"和机器总内存比。真实全量索引 5.69 GB，其中查询要读的倒排 2.12＋位置 1.20＋词典 0.35 ≈ 3.7 GB，比搜索机整机 3.6 GB 还大；压测机是 15 GB 内存的云端容器，整个索引都在缓存里，所以数字好看。搜索机上 4 路并发压测：热 p95 约 2.6 s、大量超时，Meili 被挤出缓存、慢了约 10 倍，已停服务。
修正（用户 10-19：用户很少，3–5 秒可接受，先不花钱）：与 Meili 共机时按低流量配置跑——读盘硬上限（全文只会自己慢，不抢 Meili 的盘）、不预热、并发 1、超时 6 秒（边缘函数 8 秒、浏览器 10 秒）。判据改为"串行查询 p95 ≤ 5 s、Meili 延迟不受影响"，见 `deploy/README.md` §5。不达标再另开机器（要先问用户）。
第一轮复测（30M／600 IOPS）：单并发九成查询超 6 秒，能返回的 2.1–2.2 s；Meili 整体 p95 47 ms，只有一次滑窗尖峰 138 ms。判断卡在 IOPS（mmap 缺页是 4 KB 随机读），第二轮放宽到 60M／2000，Meili 判据改为滑窗 p95 ≤ 200 ms。

## 十、阶段

| 卡 | 内容 | 状态 |
|---|---|---|
| GUJI-612 | 本设计 | 本 PR |
| GUJI-613 | 迁仓＋新查询路径＋42 部回归 | 本 PR |
| GUJI-614 | 全量建包进 GitHub Actions，传 COS | 首跑（10-17 21:21）建包 20 分、verify 14 分通过，包 4.25 GiB；传 COS 约 1 MB/s，78 分后 UserNetworkTooSlow 失败 → 改为逐块重试＋续传、失败留包可 from_run 重传 |
| GUJI-615 | 上海机部署与实测（Owen） | 待做 |
| GUJI-616 | 边缘函数 /api/fulltext、限流、开关、前端 staging | 待做 |
| GUJI-617 | 上线、夜间增量、监控 | 待做 |

## 十一、已知限制

- 精确模式对超高频字只扫前 3,000 个候选段（按书内顺序），计数与书单标 `capped`。
- `total_hits` 封顶 10,000（契约要求），超出标 `capped`。
- 服务以只读方式读索引，但 tantivy 打开索引时要在索引目录里建／锁 `.tantivy-meta.lock`（GUJI-615 第 4 步实测：只读目录下报 `Failed to acquire Lockfile: PermissionDenied`）。所以 rotate.sh 解压后把 release 改成 root 所有、所有人可读，只把 `index/` 目录本身和其中的 `.tantivy-*.lock` 交给 fulltext 用户；unit 加 `ReadWritePaths=/opt/fulltext/releases` 放行沙箱。自检临时实例用 systemd-run、照抄 unit 的用户与沙箱设置跑（无 systemd 时用 runuser），这类权限问题在切换前就能拦下（退出 10）。
