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

### P1-2 数据：正文不等 cord，格式收紧（book-index-ui＋网站＋数据流水线）
- 正文模式只等 char＋punct；cord 等书影要显示时再取（或按页拆）；entity 后到再补专名线。
- cord／punct／entity 改紧凑列式格式（需改 guji-format 规范与 CV 产出，跨领域，先出设计）。
- JSON 解析与 `adaptCharCord` 移到 Web Worker。
- **验收**：b 档正文进入视口再降 ≥ 3s；手机档不下 cord。

### P1-3 字体
- 生僻字字体自托管，按字细切（上百个小片）或服务端按章生成子集；加 preconnect。涉及 COS 上传与费用，先估成本再做。
- **验收**：样本章字体传输 ≤ 300KB。

### P1-4 平台配置（要先请示用户）
- EdgeOne 开 HTML 压缩；书影 `max-age` 延长（地址带版本时可 immutable）；站标只留一种格式。

### P2 结构性重构（视复测结果再定）
- 一段一个文本节点＋偏移表，点字用 `caretPositionFromPoint` 反查，高亮用 CSS Custom Highlight API：DOM 从 4.4 万降到几千。或按页虚拟化。
- 两条路都要改造 Ctrl+F、跨页划选、全文定位、改字与报错浮条，风险最大。

### 配套：防退化
- `perf/` 夜间门槛加阅读页场景（带 CPU 降速档），判正文进入视口、最长任务、滚动 FPS。

## 四、进度

Jira：总卡 GUJI-628（标签 `项目-阅读页性能`，挂「日常运维与优化（非里程碑）」GUJI-332）。
子卡：P0-1 GUJI-629、P0-2 GUJI-630、P0-3 GUJI-631、P1-1 GUJI-632；P1-2～P1-4 做到时再开。
