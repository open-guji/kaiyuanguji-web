# 阅读页性能：实测、根因与优化计划

> 2026-10-20 起。对象：对读阅读页（`/read/<id>/<章>`，book-index-ui 的 `TextReader` ＋网站 `ReaderClient`）。
> 进度在 Jira（GUJI，见文末），本文只放长期有用的：怎么测、为什么慢、按什么顺序改、每块怎么验收。
> 复测脚本：`perf/reader-probe.mjs`（用法见文件头）。

## 一、样本与实测（2026-10-20，线上 `https://www.openguji.com/read/96mid1ogzk/002`）

样本章：卷二，188 页、30,478 字、7,380 个标点、3,057 个专名。三档：

- **a** 桌面 1440×900，不节流
- **b** 400KB/s＋400ms RTT＋CPU 4 倍减速
- **c** 手机 390×844（DPR 3），CPU 6 倍减速

测量限制：测试机在美国（经代理，TTFB 已有 1.4–2.7s，网络绝对值偏悲观，字节数是准的）；
无 GPU，WebGL 走 SwiftShader，滚动数字是上界。对照：同条件下 `--disable-webgl`，滚动 59.7 FPS、0 个 >50ms 帧。

| 指标 | a | b | c |
|---|---|---|---|
| 正文进入视口 | 10.1s | 20.6–21.5s | 22.6–22.8s |
| 最长任务 | 1.5s | 6.3s | 9.5–10.4s |
| TBT（FCP 到网络静止） | 2.0s | 12.9s | 13.0–13.9s |
| 滚动平均 FPS（8 屏） | 13.9 | 6.2 | 20.7（手机书影隐藏） |
| 点字 INP 近似 | 70–140ms，跨页 ~0.5s | 0.4–0.5s，跨页 ~1.1s | 0.4–1.1s |
| JS 堆（GC 后） | ~58MB | 同 | 同 |

### 字节（冷缓存，约 6.15MB 传输／13.9MB 解压）

| 内容 | 传输 / 解压 | 备注 |
|---|---|---|
| HanaMin 生僻字字体 | **3.6MB**，17 个 woff2 | jsDelivr；正文里有扩展区字，各扩展区子集全拉 |
| `002.cord.json` | **772K / 3.2M** | 最大的单个资源；只有书影要用 |
| `002.char.json` | 178K / 1.4M | |
| `002.punct.json` | 82K / 1.4M | 每条约 190 字节 |
| `002.entity.json` | 126K / 1.5M | 每条约 480 字节 |
| JS | 444K / 1.37M | 阅读器 chunk 157K；繁简／异体表 94K；react-dom 61K |
| 书影 | 12 张 IIIF webp | 首屏就并发 11 张（含两张 2.4K×3.1K 原图档）；手机书影隐藏也照下 |
| HTML | 33K，**未压缩** | 整章正文没内嵌 |
| 杂项 | | `002.txt` 每次 404；`/fixtures/vol02_p10.json` 61K；站标 webp＋png 各一份 |

DOM：全页 44,659 个元素，正文区 44,101（一字一 span 30,478、标点 span 7,159、专名 `<a>` 2,860）；
约 3.4 万个事件监听；页面高 6 万（桌面）／10 万（手机）像素。

## 二、根因

### A. 首屏卡死：整章一次渲染（影响最大）
- `GujiTextViewer` 一次渲染 188 页：3 万个字 span（每个带 onClick／onMouseEnter／onMouseLeave 三个闭包；React 为 Safari 还给每个带 onClick 的元素挂空 onclick）、7 千个标点 span、2,860 个 `EntityMark`（各带 state／effect／useId）。
- 挂载后滚动监听的 `update()` 立刻 `getBoundingClientRect`，强制同步布局 6 万像素高的整页：手机档这一下 5.8–6.6s。
- 字体在正文出来后才请求，3.6MB 到了整页再排一次。

### B. 滚动卡：书影画布
- `GujiWarpCanvas` 后备缓冲按原图像素开（2345×3122），显示只有 441×587（桌面）——28 倍像素；还开着 `antialias`、`preserveDrawingBuffer`。
- 滚动每跨一页：`setActivePage` → 整个 `TextReader` 重渲染（`buildToc` 每次重跑）→ 换纹理、整张重画。8 屏换 22 次页，每次约两个 150–350ms 的帧。
- 手机书影面板隐藏（画布 CSS 0×0）时照样开 2345×3122 缓冲、下图、`img.decode()`（主线程解码 1.25s）。
- 每换页预取 4 张并预解码，缓存上限 24 张（每张解码后约 8MB）。

### C. 加载慢：请求串行、数据过大
- 链条：HTML → JS 下载执行（b 档 7.6s）→ 阅读器挂载 → 才发 char／cord／punct／entity（b 档 7–10.6s）。SSR 时章目录已知，可提前 preload。
- 正文只需 char＋punct（专名可后到），但 `resolveWarpData` 里 **没有 cord 就不进对读**，772K 的 cord 挡在正文前。
- 对读章的 `.txt` 必 404（浏览器与服务端预取各取一次）；`vol02_p10` 样张特例写死在首屏路径上，还顺带两张原图档。

### D. 交互时整树重渲染
- `hoveredCharId`、`activePage` 都是 `TextReader` 顶层 state：鼠标划过每个字、滚动跨每一页都重渲染工具条、目录、书影、正文外壳。各页 `memo` 挡住了最坏情况，但目录重建、书影重画挡不住。
- 悬停用 `querySelector('span[data-char-id=…]')` 在 3 万个节点里找。

## 三、计划（先 P0 再 P1；P2 等 P0／P1 复测后再评估）

每块：改哪里 → 验收。验收一律用 `perf/reader-probe.mjs` 对同一样本章复测，与第一节对比。

### P0-1 书影画布与书影加载（book-index-ui）
- 后备尺寸＝显示尺寸 × min(DPR, 2) × 当前缩放倍数，不超过逻辑尺寸；渲染器 viewport 取 drawingBuffer、坐标仍按逻辑尺寸；关 `antialias`、`preserveDrawingBuffer`。
- 画布不可见（CSS 尺寸 0）时不下图、不建纹理、不画；变可见再补。
- 预取只取前后各一页、只在书影面板可见时；图片缓存上限降到 8。
- **验收**：a 档滚动 ≥ 45 FPS（无 GPU 环境）、>50ms 帧 ≤ 5%；c 档首屏书影请求 0 张；书影显示、缩放清晰度、点框联动、卷二第 10 页透视样张无回归（现有 e2e）。

### P0-2 交互不重渲染整树（book-index-ui）
- 悬停改为外部小 store，只有书影画布和正文订阅；`activePage` 滚动更新做尾随节流（停 ~150ms 再换书影）；`buildToc` 等派生数据 `useMemo`。
- 字的事件改为正文容器上一个委托监听（click／mouseover／mouseout 按 `data-char-id` 取字），去掉每字三个闭包。
- 字 id → 元素查表代替全树 `querySelector`。
- **验收**：a 档点字 INP ≤ 100ms（含跨页）、b 档 ≤ 300ms；悬停、划选、点字联动、目录高亮、页指示头 e2e 全绿。

### P0-3 网站侧首屏请求（kaiyuanguji-web）
- SSR 按章条目的 `*_file` 在 `<head>` 发 `<link rel="preload" as="fetch" crossorigin>`（地址与浏览器实际请求逐字一致，含 `?v=`）。
- 对读章（声明了 `char_file`）不请求 `.txt`（浏览器与服务端预取都不取）。
- `vol02_p10` 样张：只在读者翻到第 10 页时才取样张与对偶页原图档。
- **验收**：b 档 char／punct／entity 的请求开始时间早于 JS 执行完；`.txt` 404 消失；首屏不再出现原图档请求。

### P1-1 正文分批渲染（book-index-ui）
- 先同步渲染当前位置附近约 5 页，其余每批约 10 页在空闲时补上（`startTransition`／`requestIdleCallback`）；每页 `<section>` 加 `content-visibility: auto` 与按字数估的 `contain-intrinsic-size`。
- 首帧 `update()` 不强制整页布局（推迟到首批渲染之后的下一帧）。
- `EntityMark` 改为普通 `<a>`，悬停卡由全局一个控制器管。
- 注意：网址带 `#页:列:格`、全文搜索 `?ft=` 定位、`ReaderLead` 卸载判据、`SelectionReport`／`CharFixEntry`、浏览器 Ctrl+F 都依赖 DOM 完整——锚点所在页要先渲染，全部批次完成前 Ctrl+F 可能找不全（可接受，几秒内补齐）。
- **验收**：a 档最长任务 ≤ 200ms、b 档 ≤ 800ms、c 档 ≤ 1.2s；正文进入视口 b 档 ≤ 12s；上述依赖 DOM 的功能 e2e 全绿。

### P1-2 数据：正文不等 cord、阅读器专用派生文件（GUJI-700；book-index-ui＋网站＋网站数据打包）
- **手机不取 cord**：手机端书影栏收起（读书影走底部抽屉里的普通图片，不用字框），cord（772K／解压 3.2MB，最大的单个文件）对它没用。
  阅读页按视口取：窄屏只取 char／punct／entity／norm，cord 的 preload 也带 `media`；视口跨过断点（转横屏）再补取。
- **阅读器专用派生文件**（设计，见下；不改 CV 产出与 guji-format 规范，由网站数据打包生成）。
- Worker 解析：派生文件落地后再评估。结构化克隆回主线程的开销与 JSON 解析同量级，先瘦身收益更确定。
- **验收**：手机档不下 cord；派生文件落地后样本章对读数据解压 ≤ 2MB、首帧 JSON 解析 ≤ 30ms（桌面）。

#### 设计：阅读器专用派生文件（2026-10-20 草案）

**问题**：网站直接读 CV 产出的真源文件，大量字段阅读器用不到（样本章 002 实测）：

| 文件 | 解压 | 阅读器用不到的 | 占比 |
|---|---|---|---|
| cord | 3.25MB | 每页 `producers`／`marks`／`regions`／`columns`（0.75MB）、每格 `id`（0.58MB）、格位键 `a`（0.43MB，可由 char 读序对齐） | ~55% |
| punct | 1.44MB | `source`（0.21MB）、`char_offset`（0.14MB）、对象键名重复 | ~40% |
| entity | 1.51MB | `target.href`、`span`、`source`、`target.status`（非 matched 时才有意义）、键名重复 | ~50% |
| char | 1.46MB | 每格 `{"a":…,"c":…}` 的键名与格位键（列内格号多数连续） | ~60% |

**做法**：网站数据打包（把 book-text 文本同步到 COS 的那一步）按章额外生成两个派生文件，写进版本目录，并在同步上去的 `index.json` 章条目里加声明：
- `NNN.reader.json`（`reader_file`）：char＋punct＋entity＋norm 合成一份——
  - 字：每列 `c` 为字数组，格号连续时不带格位键，只在不连续／有子列（夹注 a/b）时带；`lane`／`lacuna`／`guess`／`zi`、列的 `raised`／`lead_blank`／`kind`、页 `label` 稀疏携带；
  - 标点：`[格位键, mark, kind?, pos?, label?, toc?]` 数组（`kind=point`、`pos=after` 缺省不写）；
  - 专名：`{id, t: 类型, a: [起, 止], x: 原文, e: 条目 id, n: 规范名, g: 分组}`，非 matched 不带 `e`；
  - 来源：`src` 记各真源文件的版本号与 sha256，可追溯、可校验。
- `NNN.reader-cord.json`（`reader_cord_file`）：每页 `{page, seq, w, h, b}`，`b` 为按 char 读序排列的扁平整数框 `[x, y, w, h, …]`（缺框写 -1），不带格位键。

**网站读法**：章条目有 `reader_file` 就只取它（＋宽屏时 `reader_cord_file`）；没有就照旧取真源五个文件——先上读法与回退，再随下一次数据发布生成派生文件，任何一步都不会读不到。

**预期**（样本章）：对读数据解压 7.6MB → 约 1.5MB（br 传输约 1.2MB → 约 0.35MB），请求 5 个 → 2 个，首帧 JSON 解析约 85ms → 约 20ms。

**待定**：派生脚本归网站数据打包（`nextjs/scripts/`）；生成逻辑需与 book-index-ui 的 `adaptCharCord`／`adaptPunctJson`／`adaptEntityJson` 同口径，用同一组样本章做往返一致性测试（派生 → 还原 → 与真源适配结果逐字段相等）。

#### 实施（2026-10-20）：改为「同结构瘦身副本」，不做紧凑格式

上面的紧凑格式（合并文件、键名数组化、省格位键）要在 web 端写解码器。量过之后发现，**只删阅读器不读的字段、结构不变**，就能拿到大部分收益：

| 文件 | br 传输 原→瘦 | 解压 原→瘦 | 做不做 |
|---|---|---|---|
| cord | 573KB → 202KB | 3.25MB → 1.28MB | 做 |
| punct | 55KB → 34KB | 1.44MB → 0.59MB | 做 |
| entity | 84KB → 62KB | 1.51MB → 0.63MB | 不做：ui 的 `span` 偏移在用，能删的只剩 source 等 |
| char | 110KB → 105KB | 1.46MB → 0.86MB（只去缩进） | 不做 |

- 副本是原 schema 的合法子集，web 与 ui 的读法都不用改，没有解码器。
- 打包（`scripts/lib/reader-files.mjs`，挂在 bundle-data 拷完条目之后，纯 Node，无额外依赖）给对读章写 `<章>.cord.reader.json`、`<章>.punct.reader.json`，产物 index.json 章条目记 `reader_cord_file`、`reader_punct_file`。
- 原文件和 `cord_file`／`punct_file` 一律不动：校对页等照旧读原文件。
- 留哪些字段以 ui 的读法为准：cord 留 `page`、`canvas{id,seq,width,height}`、`image{width,height}`、`cells[].a/box`；punct 去掉 `source`、`char_offset` 与顶层 `metadata`、`stats`。
- 读法：`loadDuiduFiles` 先取副本，取不到回落原文件；页面 preload 也改为预取副本。
- 往返一致性：单测用 book-index-ui 的 `adaptCharCord`／`iiifVolumeOf`／`adaptPunctJson`，比较副本与原文件的读法结果；样本章真数据（设 `READER_FILES_SAMPLE_DIR`）逐字段相同。
- 收益（样本章，宽屏）：对读数据 br 传输 822KB → 403KB，解压 7.66MB → 3.37MB（JSON 解析量减半以上）。窄屏本来就不取 cord，只省 punct 那一份。

### P1-3 字体：对读章生僻字子集（GUJI-701）
- **问题**：扩展区汉字兜底是花园明朝（`globals.css` 的 HANAMIN 段，jsDelivr 上按 unicode-range 分的片，每片约 200KB）。
  样本章 31 个生僻字散在 19 片里，读者往下读要下约 3.6MB（实测 15 个请求）。
- **机制**：CSS 规定同字族多条 `@font-face` 的 unicode-range 重叠时，**后定义的先查**。服务端渲染时在 body 里追加两条
  `@font-face`（`HanaMinA`、`HanaMinB` 各一条，同一个 src，只下一次），unicode-range 恰是本章的生僻字，
  这些字就从子集取，大分片根本不会被请求。字体栈不用改；子集取不到时照旧回落分片。
- **生成**（`nextjs/scripts/lib/chapter-fonts.mjs` ＋ `scripts/chapter-fonts.py`，挂在 bundle-data 拷完条目目录之后）：
  - 范围：只做对读章（章条目有 `char_file`）。全站 8791 个条目、约 19 万个文本文件，每次发布都给全部章节做繁简转换加子集太慢；对读章少，且是功能最全、最重的页面。
  - 收字：char 原字 ∪ norm 规范字 ∪ 全书目录（章名与各级标题），再加上它们经网站统一的繁→简入口（`scripts/lib/to-simplified.mjs`：异体归一＋opencc t2cn）转出的字。网站默认简体，鉷→𫟹、巘→𪩘、驎→𬴊 这类转换结果本身就落在扩展 C～E 区，不收的话照样会去下分片（实测漏掉了 3 片）。只收落在 HANAMIN 段 unicode-range 里、且分片里确有字形的码位。
  - 产物：`<章>.font.woff2` 放在版本目录（样本章 35 字、11KB）；产物 `index.json` 的章条目写 `font_file`、`font_range`。首屏种子 read-seed 改为读产物的 index.json，带上这两个字段。
  - 可复现：Merger 会把 `head` 的时间戳写成当前时间，改回源分片的值；fontTools／brotli 版本锁死。三处打包（data.yml 的 package 与 h1 文本两个 job、deploy.yml）共用 `ops/setup-chapter-fonts.sh`（venv 安装，ubuntu-latest 拒绝 `pip --user`），并设 `KYG_CHAPTER_FONTS=required`：缺依赖就让打包失败，不静默地有的有字体、有的没有。本地缺依赖只警告、不生成。
  - 上传：`.woff2` 的 Content-Type 设为 `font/woff2`；data.kaiyuanguji.com 已返回 `access-control-allow-origin: *`（跨域字体要求）。存储与流量费用可忽略（每个对读章约 10KB，而且读者省下了 3.6MB 的 jsDelivr 流量）。
- **页面**（`page.ssr.tsx`）：对读章有合规的 `font_file`／`font_range` 就出 `<link rel=preload as=font>` ＋ `<style id="kyg-chapter-font">`。h1 哈希寻址布局不出（与对读数据 preload 一致）。
  站内换章不经服务端渲染：阅读器取新章对读数据时调 `lib/chapter-font.ts` 的 `ensureChapterFont`，在 body 末尾补一条新章的 `@font-face`（同一地址不重复加；h1 哈希布局给不出地址就不加，照旧走分片）。
- **验证**：本地用 COS 上样本章的真实 index／char／norm 跑生成，再拦截页面 HTML 注入同样的 style，字体请求从 15 个分片降到 1 个（11KB）。
- **验收**：样本章字体传输 ≤ 300KB（上线后在线上复测）。

### P1-4 平台配置（要先请示用户）
- EdgeOne 开 HTML 压缩；书影 `max-age` 延长（地址带版本时可 immutable）；站标只留一种格式。

### P2 结构性重构（视复测结果再定）
- 一段一个文本节点＋偏移表，点字用 `caretPositionFromPoint` 反查，高亮用 CSS Custom Highlight API：DOM 从 4.4 万降到几千。或按页虚拟化。
- 两条路都要改造 Ctrl+F、跨页划选、全文定位、改字与报错浮条，风险最大。

### 配套：防退化
- `perf/` 夜间门槛加阅读页场景（带 CPU 降速档），判正文进入视口、最长任务、滚动 FPS。

## 四、已做与复测（2026-10-20）

同一台机器、同一份数据，本机构建全栈站点（`KYG_RENDER_MODE=fullstack`），改前＝book-index-ui 0.60.1，改后＝0.61.0＋网站 P0-3。
桌面档取第三轮，慢网／手机档取第四轮（第四轮只改了页码跟随，不影响桌面档）。

| 指标 | 桌面 改前→改后 | 慢 4G＋CPU4x 改前→改后 | 手机＋CPU6x 改前→改后 |
|---|---|---|---|
| 正文进入视口 | 6.1s → 2.9s | 23.9s → 7.4s | 17.9s → 7.2s |
| 最长任务 | 1.52s → 0.24s | 6.77s → 0.68s | 8.75s → 0.78s |
| 长任务总时长 | 2.8s → 0.66s | 14.2s → 2.1s | 13.0s → 4.9s |
| 滚动 FPS（>50ms 帧） | 13.7（45）→ 60（0） | 6.2（77）→ 25.8（26） | 19.0（37）→ 33.2（15） |
| 点字最慢 | 544ms → 96ms | 1952ms → 304ms | 1192ms → 768ms（首次，批次未补完）；其余 ≤400ms |
| 首屏书影 | 13 张 796K → 3 张 | 14 张 805K → 3 张 | 13 张 796K → 0 张 |
| 画布后备 | 2345×3122 → 448×596 | 同左 | 2345×3122 → 1×1（隐藏） |

- 慢网档的对读数据从 JS 执行完（约 7s）提前到 0.4s 开始下载（preload），每个文件只请求一次。
- 无 GPU 环境（SwiftShader）下慢网档滚动仍只有 26 FPS，主要是换页时上传纹理；真机有 GPU 会好得多。
- 首帧（ui 0.61.1）：profile 发现首帧最大的一块是「量行宽」effect 当场读 `clientWidth` 强制排版首批正文（约 90ms），量完 setState 又让各页整体重渲染；
  页码跟随首判当场读位置又强制排版一次（约 50ms）。改为画完这一帧再量、结果写容器 CSS 变量（各页 `contain-intrinsic-size` 用 calc 折算，不重渲染），
  页码首判推到下一帧。最长任务：桌面 240→177ms（达标）、慢网 676→489ms、手机 777→580ms。
- 首帧剩下的大头：JSON 解析（约 70–85ms，8MB 解压后）、`adaptCharCord`（约 28ms）、GC（约 60–90ms）。下一步属 P1-2（数据瘦身、Worker 解析）。

### 过程中踩到的
- **webpack 持久缓存按包版本号命中**：本地装改过的 book-index-ui 而不改版本号，`next build` 照样打进旧代码。发版必须升版本号；本地验证要删 `.next/`。
- **画布后备缩小后外框跟着缩**：外框在 flex 布局里按画布的固有尺寸撑开。改成一张按逻辑尺寸声明宽高的空 SVG 占位撑外框，画布绝对定位铺满。
- **content-visibility 下别读屏幕外元素的位置**：页码跟随原来二分查找时读标题、并页首字的 `getBoundingClientRect`，每读一个就强制排版一整页被跳过的内容（profile 里占 1.1s）。改成二分只读页框外框，精确判断只在参考线所在页框里做。
- **分批渲染里任何「每批全量扫 DOM」都是平方级**：页锚点逐页 `querySelector`、按字 id 重建全章字表，各占数百毫秒。一次 `querySelectorAll` 取齐。

### 线上复测（2026-10-20 上线 0.61.1 后，`www.openguji.com/read/96mid1ogzk/002`，与第一节同一环境）

| 指标 | 桌面 上线前→后 | 慢 4G＋CPU4x 上线前→后 | 手机＋CPU6x 上线前→后 |
|---|---|---|---|
| 正文进入视口 | 10.1s → 8.6s（CDN 预热后；新部署首访 12.5s，JS 回源慢） | 20.6s → 10.7s | 22.8s → 12.7s |
| 最长任务 | 1.50s → 0.14s | 6.32s → 0.49s | 10.43s → 0.76s |
| 长任务总时长 | 2.1s → 0.38s | 13.5s → 2.5s | 14.6s → 5.0s |
| 滚动 FPS（>50ms 帧） | 13.9（44）→ 53–55（0–2） | 6.3（74）→ 23.9（34） | 21.0（34）→ 30.1（18） |
| 点字最慢 | 480ms → 112ms | 1120ms → 616ms（首次）／其余 ≤392ms | 880ms → 704ms（首次）／其余 ≤224ms |
| 首屏加载窗口内传输 | 6.15MB → 2.0MB（字体 3.6MB 挪到正文出来之后才下，总量没少） | 同左 | 6.1MB → 1.8MB |
| 首屏书影 | 14 张 805K → 3 张 276K | 同左 | 13 张 → 0 张 |

桌面档的「正文进入视口」主要卡在网络：测试机经美国代理下 JS 要 5 秒以上；对读数据 preload 在 3.4s 前就下完了。
剩下一个串行环节：浏览器拿到 JS 后先取 `latest.json`（no-store，约 1s）拿版本号，才用上预取好的数据——可由服务端把版本号随页面交给浏览器省掉。
字体（17 个文件、3.6MB）不再挤在首屏加载里（分批渲染后，生僻字所在的页渲染到了才触发对应子集），但读者往下读仍会全部下载，见 P1-3。

## 五、进度

Jira：总卡 GUJI-628（标签 `项目-阅读页性能`，挂「日常运维与优化（非里程碑）」GUJI-332）。
子卡：P0-1 GUJI-629、P0-2 GUJI-630、P0-3 GUJI-631、P1-1 GUJI-632；不等 latest.json GUJI-699、P1-2 GUJI-700、P1-3 GUJI-701、小屏书影栏被横幅裁 GUJI-702。

2026-10-20 第二轮（ui 0.61.2，book-index-manager#231；网站 kaiyuanguji-web#535）：
- GUJI-699：服务端把数据版本键随首屏数据给浏览器，对读文件不再先串行等 `latest.json`。
- GUJI-700：窄屏既不取也不 preload cord。中途发现回退：没有 cord 时，隐藏的书影画布按 0 尺寸画字框，坐标全是 NaN，手机上点一个字卡 3.3 秒。
  ui 0.61.2 改为没坐标时回落普通书影。修好后本地移动档（6× CPU）对比 0.61.1：正文入视口 10.2→5.1s，滚动 29→37fps，控制台报错 4317→0。
- GUJI-702：书影栏高度扣掉「比吸顶位置低多少」，有横幅时翻页按钮不再落到视口外。
- GUJI-701：对读章生僻字子集，见 P1-3。
PR：book-index-manager#229（ui 0.61.0）、#230（ui 0.61.1 首帧）；kaiyuanguji-web#525（本文、探针、P0-3、升 0.61.0）、#527（升 0.61.1）。
2026-10-20 已发 npm 0.61.0／0.61.1，网站合并后按 deploy.yml 测试站 verify → 自动上正式站。
顺带：#524 起 verify 红在 `duidu-003 无字页翻页`，是章首新横幅把翻页按钮推出 720 高视口、click 自带滚动被误判，#526 修测试（横幅让小屏首屏书影栏底部被裁约 45px，另行处理）。

另记（P1-4）：站标 `open-guji-logo.png`（794×698）当 favicon，导航栏 26px 图标用 46KB 的 webp 原图，可换小图。
