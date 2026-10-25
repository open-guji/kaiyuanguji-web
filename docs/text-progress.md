# 后台「文本整理」栏目：数据放哪、谁来写、网站怎么看

> A41，2026-10-25 起。用户要求：在管理后台加一个「文本整理」栏目，看所有书、所有册的整理进度；
> 数据由各领域的 job 算好写进 Neon 中心库的新表，网站统一读，允许有些延迟。
> 代码：`ops/text-progress/`（表结构、同步脚本）、`edge-functions/api/text-progress.js`、`nextjs/src/app/admin/text/`、
> `.github/workflows/text-progress.yml`。

## 〇、分工：谁负责什么（2026-10-25 用户定，各领域据此开始填数）

| 谁 | 负责什么 | 写到哪 |
|---|---|---|
| 网站（A41） | 页面、接口、同步任务、基础采集；同步挂了要修 | 基础采集软写 `progress.volume` 的版本、待审等字段（见 2.1「基础采集」各行） |
| A31 粗校 | 每册全册格数、已人裁格数、备注；粗校人审率 | `progress.volume` 的 `cells_total`、`human_judged`、`note`；人审率写 `progress.metric`（section `review`） |
| A24 形近字 | 「形近字」栏（10-25 起异体字组并进来）：各字组总表、准确率、待审里的形近格数等，口径自定 | `progress.metric`（section `xingjin`） |
| A32 精校 | 「人审」栏：人审率、已裁格数、网站意见处理等；精校阶段的 `stage`、`note` | `progress.metric`（section `review`）、`progress.volume` |
| A33 点校 | 标点、专名进度一句话 | `progress.volume` 的 `punct_status` |
| A30 重跑任务 | 「重跑任务」栏：任务库（`guji_jobs`）里在跑、排队、最近结束的任务一张表（配置、状态、阶段、开始时间、已跑、预计完成、结果包）；cv `open_guji_cv/jobs/board.py` 在执行方领单、收尾、心跳时写，`guji job board` 手动刷新 | `progress.metric`（section `jobs`，一条 `board`，`detail.table`） |
| 新领域 | 要开新栏目就在 `progress.section` 插一行，侧栏自动多一个小标题 | `progress.section`、`progress.metric` |

- 口径归各领域自己：数算得对不对、怎么定义，由写的一方负责；网站只负责原样显示。
- 怎么写：用自己的中心库连接调 `progress.put_volume`／`progress.put_metric`（例子见 2.1、2.2、2.3），每个字段会记下写入方和时间。
- 什么时候看到：「重跑任务」栏每 30 分钟搬一次（定时任务只跑 export 段）；其余栏目随同步每 6 小时一次（UTC 每 6 小时的 37 分，洛杉矶夏令时约 5:37、11:37、17:37、23:37；GitHub 定时常晚），急着看可以在 Actions 手动跑 text-progress。

### 后台页面长什么样

- 「文本整理」点进去是**总览**：上面四张统计卡（套书数、精校中、已出 1.0、待人审格），一条各阶段分布色条，
  下面按套书分组的各册进度表（一册一行：册、卷次、阶段、文本／标点／专名版本、待人审、待审单、cv、备注、更新）。
- 侧栏在「文本整理」下面按 `progress.section` 列小标题，每个栏目一页（手机上是页面顶部的页签），见 2.2。
- 后台随窗口铺满，不限宽；风格是简洁看板，不花哨（用户 10-25 定）。

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
| `pending_review`、`pending_rev`、`pending_at` | 待人审格数、线上待审单 rev、出单时间 | **A32 写**（口径：单上格扣掉出单后已有人裁的、现行文本里已没有的，见 cv `scripts/zhengli/progress_report.py`）；A32 没写的册由基础采集兜底，数单上原始格数，页面标「≈」 |
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
  一个数的 `detail` 里放了 `table`（`{columns: [{key, label, unit?, hint?}], rows: [{…}], note?}`）就不做卡片，画成一整张可排序的表；
  行里的 `_sub`（同一形状）是点开那一行后显示的子表。比率列 `unit` 写 `%`、按小数存。
- `progress.section` 登记栏目，侧栏按 `sort` 排。先占好的：`xingjin` 形近字（A24，10-25 起含异体字组）、
  `review` 人审（A32）。口径由各领域自己定（改 `description`）；要新开栏目就 INSERT 一行。
- `progress.metric` 一个数一行，主键 `(book_id, vol, section, key)`，再写就覆盖。`vol = ''` 表示整套书，`book_id = ''` 表示不分书。
  比率按小数存、`unit` 写 `%`（页面显示成百分数）；不是数的写 `value_text`；明细放 `detail`。

```sql
SELECT progress.put_metric('96mid1ogzk', '', 'xingjin', 'accuracy', '形近字准确率', 0.973, '%', 'A24');
SELECT progress.put_metric('96mid1ogzk', '005', 'review', 'web_open', '网站意见（未处理）', 23, '条', 'A32');
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

## 五、上线记录（2026-10-25，用户批准）

1. Neon 正式库（guji-data 项目 main 分支）执行了 `schema.sql`（只新建 `progress` schema，不动已有表）。
2. 用 SQL 建了账号 `progress_sync`（不进 neon_superuser，只有 `grants.sql` 给的权限），口令由用户自设。
3. 用户把 `progress_sync` 的连接串加进本仓 secret `PROGRESS_DATABASE_URL`。没配时定时任务整次跳过、不报红。
4. PR #593、#594 合并；手动跑 text-progress 先 `dry_run` 再正式，首跑 26 册。
5. 为省算力：同步从每小时改每 6 小时（每次都会叫醒 Neon，按醒着的时间计费）；Neon 自动伸缩上限从 8 CU 降到 2 CU。

## 六、后台怎么登录

后台 `https://www.openguji.com/admin`，没有密码，靠邀请链接＋cookie：用绑定自己邮箱的 admin 邀请链接（`/join?c=…`，7 天有效、一次性）
点「确认加入」，cookie 有效 180 天、访问时自动续期。链接由已登录的管理员在 `/admin/invites` 生成；没人能登录时用 `AUTH_ADMIN_TOKEN`
调 `POST /api/auth/invite`（body `{"email": "…", "role": "admin"}`）。旧域名 kaiyuanguji.com 上的登录不带到 openguji.com。
EdgeOne Pages 里改了环境变量（如 `AUTH_ADMIN_TOKEN`）要**重新部署**才生效，否则线上还是旧值、调接口报「未授权」。令牌和邀请链接不要贴进聊天。
