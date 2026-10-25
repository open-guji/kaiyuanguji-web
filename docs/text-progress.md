# 后台「文本整理」栏目：数据放哪、谁来写、网站怎么看

> A41，2026-10-25 起。用户要求：在管理后台加一个「文本整理」栏目，看所有书、所有册的整理进度；
> 数据由各领域的 job 算好写进 Neon 中心库的新表，网站统一读，允许有些延迟。
> 代码：`ops/text-progress/`（表结构、同步脚本）、`edge-functions/api/text-progress.js`、`nextjs/src/app/admin/text/`、
> `.github/workflows/text-progress.yml`。

## 一、数据怎么走

```
各领域 job（A30–A34、A2x）──SQL──▶ Neon 中心库 progress schema ◀──软写── 基础采集（sync.py collect，网站定时任务）
                                         │                                    ▲ 读：册 yaml（books）、待审单（files）、book-text 版本
                                         ▼
                      定时任务 text-progress.yml（每 6 小时）：sync.py export → POST /api/text-progress
                                         ▼
                      EdgeOne KV（FEEDBACK_KV 的 tp:snapshot）──▶ 后台 /admin/text（只给 admin）
```

- **为什么不让页面直连 Neon**：网站在国内 EdgeOne 上，国内到 Neon 不稳，中心库设计（ai-team `通用/中心库设计.md` 第一节）
  定了国内页面不直接读写 Neon。所以和 `proofing-sync` 一样，由 GitHub 定时任务搬运。每 6 小时一次，延迟最多 6 小时出头（GitHub 定时偶尔晚几小时，
  页面上超过 12 小时没更新会提示）。不跑得更勤，是因为每次都会叫醒 Neon，按醒着的时间计费（每次至少约 5 分钟）。
- **为什么不现算**：各册的数分散在中心库、book-text、各领域自己的产物里，有的要跑统计；由各领域算好写表，网站只读，口径各自负责。
- 快照只存在 KV、只给 admin 看，不发 COS（COS 是公开的）。

## 二、表（`ops/text-progress/schema.sql`，schema `progress`）

### 2.1 `progress.volume`：一册一行（栏目第一部分）

主键 `(book_id, vol)`：套书是 book-index 的 Book id（如 `96mid1ogzk`），册是 book-text 的章号（三位，如 `005`），
与待审单路径 `feedback/lists/proofing/<书>/<章>.pending.json` 同口径。没有 book-index id 的工作区（如 `qtw-draft`）
`book_id` 写工作区 id、`vol` 写 cv 册 id。

| 字段 | 意思 | 现在谁填 |
|---|---|---|
| `book_title`、`vol_title`、`vol_order` | 套书名、本册卷次、排序 | 基础采集（工作区目录名、book-text 章标题、册 yaml title） |
| `ws`、`cv_book` | cv 工作区 id、cv 册 id（`vol05`） | 基础采集 |
| `stage` | 阶段：`todo` 未开工／`pipeline` 跑管线／`rough` 粗校／`fine` 精校／`released` 已出 1.0 | **领域写**；没写时页面按文本版本推断（标虚线框） |
| `text_version`、`punct_version`、`entity_version`、`proofing` | 三线版本、精校页开没开 | 基础采集（book-text 原创版本的 `index.json`，default 为准） |
| `frozen_version` | 冻结在哪一版 | 基础采集（册 yaml `freeze.at`） |
| `cv_version`、`corpus`、`glyph_pin` | 本册固定的 cv 版本、语料号、字形库快照号 | 基础采集（册 yaml） |
| `pending_review`、`pending_rev`、`pending_at` | 待人审格数、线上待审单 rev、出单时间 | 基础采集（待审单的格数） |
| `cells_total`、`human_judged` | 全册格数、已人裁格数 | 领域写（A31／A32） |
| `punct_status` | 标点进度一句话（如「试跑，未入库」） | 领域写（A33） |
| `note` | 备注：卡在哪、等谁 | 领域写 |
| `extra` | 其余附带信息（浅合并，页面不逐项显示）；基础采集放了 `web.pending_cls`（待审格按原因分类计数）等 | 各方，键带自己的前缀 |

阶段推断口径（三阶段流程第二节）：文本 `0.x` → 精校（0.1.0 ＝粗校完成可上网站，之后每合一批人裁升 minor）；`≥1.0.0` → 已出 1.0；
没有文本但有 cv 册 → 粗校；都没有 → 未开工。

**写法**：一律调 `progress.put_volume(book_id, vol, 字段 jsonb, 写入方)`，只放要改的字段（值为 null ＝清空），
不认识的字段整次拒绝；每个字段记下谁、何时写的（`field_meta`）。

```sql
SELECT progress.put_volume('96mid1ogzk', '006',
  '{"cells_total": 31234, "human_judged": 412, "note": "等推库：r5 上 16 格"}', 'A32');
```

**基础采集是软写**：某个字段一旦被别的写入方写过，采集就不再碰它。所以领域要接管哪个字段（比如 A32 想自己报
`pending_review`），直接写就行；要还给采集，在库里把 `field_meta` 里那个键删掉。

### 2.2 `progress.section` 与 `progress.metric`：各领域自己的数（各栏目分页）

- 后台「文本整理」点进去是总览（各册进度，即 `progress.volume`）；侧栏在它下面按栏目列小标题，每个栏目一页
  （`/admin/text/section?s=<section>`）：整套或全局的数（`vol` 留空）做成卡片，各册的数排成一册一行、一个 key 一列的表。
- `progress.section` 登记栏目，侧栏按 `sort` 排。先占好的三个：`xingjin` 形近字（A24）、`yiti` 异体字组（A24）、
  `review` 人审（A32）。口径由各领域自己定（改 `description`）；要新开栏目就 INSERT 一行。
- `progress.metric` 一个数一行，主键 `(book_id, vol, section, key)`，再写就覆盖。`vol = ''` 表示整套书，`book_id = ''` 表示不分书。
  比率按小数存、`unit` 写 `%`（页面显示成百分数）；不是数的写 `value_text`；明细放 `detail`。

```sql
SELECT progress.put_metric('96mid1ogzk', '', 'xingjin', 'accuracy', '形近字准确率', 0.973, '%', 'A24');
SELECT progress.put_metric('96mid1ogzk', '005', 'review', 'web_open', '网站意见（未处理）', 23, '条', 'A32');
SELECT progress.put_metric('', '', 'yiti', 'status', '异体字组', NULL, NULL, 'A24', '试跑中');
```

### 2.3 从会话里写

有 `NEON_DATABASE_URL` 的环境（Default 环境）直接用 open-guji-cv 的连库函数（只通 443 的云会话自动起桥）：

```python
import json
from open_guji_cv.datastore.connect import connect
with connect() as conn:
    conn.execute("SELECT progress.put_volume(%s, %s, %s::jsonb, %s)",
                 ("96mid1ogzk", "006", json.dumps({"human_judged": 412}), "A32"))
```

写正式库照各领域自己的规矩（如 A30／A32 写中心库前要用户说「推库」）。`progress` 只是看板数据，不影响任何产物和文本。

## 三、同步脚本 `ops/text-progress/sync.py`

| 子命令 | 做什么 |
|---|---|
| `init` | 建 progress schema（幂等） |
| `collect [--dry-run] [--out f]` | 基础采集，软写 `progress.volume`；`--from-worker` 改经 guji-data Worker 读真源（读令牌即可），配 `--dry-run` 完全不连库 |
| `export [--out f] [--put 站点]` | 读 `progress.*` 出快照，`--put` 传到 `<站点>/api/text-progress`（要 `FEEDBACK_ADMIN_TOKEN`） |

连库读 `--dsn`、`PROGRESS_DATABASE_URL` 或 `GUJI_DATA_PG_DSN`。定时任务用专用账号 `progress_sync`（`grants.sql`：只管 progress，只读
`books`／`files`／`workspaces`）。

10-25 用读令牌只读试跑（`collect --from-worker --dry-run`）：5 个工作区、26 册 yaml、18 张待审单、book-text 1 部书 → 26 册，
殿本 20 册的三线版本、待人审格数、cv 版本都取到了。

## 四、接口 `/api/text-progress`

- `GET`：admin 成员 cookie 或 `Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>`；回 `{success, snapshot | null, stored_at}`。
- `POST`：只认 `FEEDBACK_ADMIN_TOKEN`；请求体是整份快照（`schema: "text-progress/1"`，≤5 MB），覆盖 KV 的 `tp:snapshot`。

## 五、上线要用户点头的几步

1. 在 Neon 正式库执行 `schema.sql`（只新建 `progress` schema，不动已有表）。
2. 在 Neon 控制台建账号 `progress_sync`，执行 `grants.sql`。
3. 把 `progress_sync` 的连接串加进本仓 secret `PROGRESS_DATABASE_URL`。没配之前定时任务整次跳过、不报红。
4. 合并本 PR；之后手动跑一次 Actions → text-progress（先 `dry_run`，再正式）。

## 六、后台怎么登录

后台 `https://www.openguji.com/admin`，没有密码，靠邀请链接＋cookie：用绑定自己邮箱的 admin 邀请链接（`/join?c=…`，7 天有效、一次性）
点「确认加入」，cookie 有效 180 天、访问时自动续期。链接由已登录的管理员在 `/admin/invites` 生成；没人能登录时用 `AUTH_ADMIN_TOKEN`
调 `POST /api/auth/invite`（body `{"email": "…", "role": "admin"}`）。旧域名 kaiyuanguji.com 上的登录不带到 openguji.com。
